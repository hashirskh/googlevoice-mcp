#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ensureBrowser, launchLoginBrowser, closeBrowser, checkLoginStatus, REMOTE_DEBUG_PORT } from './browser.js'
import { listSms, readConversation, sendSms, replySms, markAsRead, CHIP_SELECTOR, chipNumbers } from './actions.js'
import { number, suggestionNumber } from './safe-send.js'

const server = new Server(
  { name: 'googlevoice', version: '0.0.1' },
  {
    capabilities: { tools: {} },
    instructions: 'For separate SMS outreach, ask for the recipient phone numbers and the message template if missing. Send only when the user explicitly authorizes sending. Use gv_send_sms once per unique number, sequentially, with a single phone_number string. Never use group SMS or reply tools for outreach. Stop on the first error or uncertain outcome. Never retry an uncertain send automatically. Report submission separately from delivery.',
  },
)

// --- Tool Definitions ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'gv_inspect_setup', description: 'Inspect recipient chips and composer; optionally open an empty composer or preview a number suggestion. Never sends.', inputSchema: { type: 'object' as const, properties: { open_composer: { type: 'boolean' }, preview_number: { type: 'string' } } } },
    {
      name: 'gv_login',
      description:
        'Open or bring forward the dedicated Google Voice Chrome window for interactive sign-in. On Windows, sign in directly in that window. After login, call gv_check_login to verify.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'gv_check_login',
      description: 'Check whether the user is currently logged into Google Voice.',
      inputSchema: { type: 'object' as const, properties: {} },
    },
    {
      name: 'gv_list_sms',
      description:
        'List recent SMS conversations from Google Voice. Returns conversation ID, contact, last message snippet, timestamp, and read/unread status.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filter: {
            type: 'string',
            enum: ['all', 'unread'],
            description: 'Filter conversations: "all" or "unread" only. Default: "all".',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of conversations to return. Default: 20.',
          },
        },
      },
    },
    {
      name: 'gv_read_sms',
      description:
        'Read messages within a specific SMS conversation. Returns individual messages with sender, text, timestamp, and direction.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          conversation_id: {
            type: 'string',
            description: 'The conversation ID (from gv_list_sms results).',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of messages to return (most recent). Default: 50.',
          },
          filter: {
            type: 'string',
            enum: ['all', 'unread'],
            description: 'Filter: "all" returns messages regardless, "unread" only returns messages if the conversation has unread messages. Default: "all".',
          },
        },
        required: ['conversation_id'],
      },
    },
    {
      name: 'gv_send_sms',
      description: 'Submit one separate SMS to exactly one phone number. Call sequentially, once per recipient. Stop on the first error or uncertain outcome.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          phone_number: {
            type: 'string',
            description: 'Exactly one US phone number, preferably in +1 format.',
          },
          text: {
            type: 'string',
            description: 'The message text to send.',
          },
        },
        required: ['phone_number', 'text'],
        additionalProperties: false,
      },
    },
    {
      name: 'gv_reply_sms',
      description: 'Unavailable. Use gv_send_sms for explicitly authorized messages to one phone number.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          conversation_id: {
            type: 'string',
            description: 'The conversation ID to reply to.',
          },
          text: {
            type: 'string',
            description: 'The reply message text.',
          },
        },
        required: ['conversation_id', 'text'],
      },
    },
    {
      name: 'gv_mark_read',
      description: 'Mark an SMS conversation as read.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          conversation_id: {
            type: 'string',
            description: 'The conversation ID to mark as read.',
          },
        },
        required: ['conversation_id'],
      },
    },
  ],
}))

// --- Tool Handlers ---

function errorResult(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }], isError: true }
}

function textResult(msg: string) {
  return { content: [{ type: 'text' as const, text: msg }] }
}

async function requireLogin(): Promise<string | null> {
  const loggedIn = await checkLoginStatus()
  if (!loggedIn) {
    return 'Not logged in to Google Voice. Please run gv_login first.'
  }
  const expectedAccount = process.env.GOOGLEVOICE_EXPECTED_ACCOUNT
  if (!expectedAccount) return 'Account ownership has not been configured; confirm the selected account first.'
  const page = await ensureBrowser()
  const label = await page.getByRole('button', { name: /Google Account:/ }).getAttribute('aria-label').catch(() => '')
  if (!label?.includes('(' + expectedAccount + ')')) return 'Selected Google Voice account differs from the confirmed account. Stopped.'
  return null
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  if (req.params.name === 'gv_send_sms') {
    try { number(args.phone_number) } catch { return errorResult('Exactly one US phone_number string is required. Group sends are disabled.') }
    if (Object.keys(args).some(key => key !== 'phone_number' && key !== 'text')) return errorResult('Only phone_number and text are accepted.')
    if (typeof args.text !== 'string' || !args.text.trim()) return errorResult('Nonempty message text is required.')
  }
  if (process.env.GOOGLEVOICE_ALLOW_WRITES !== '1' && ['gv_send_sms', 'gv_reply_sms', 'gv_mark_read'].includes(req.params.name)) {
    return errorResult('Writes disabled during setup. Enable GOOGLEVOICE_ALLOW_WRITES=1 only after authorizing a recipient and message.');
  }

  try {
    switch (req.params.name) {
      case 'gv_inspect_setup': {
        const loginErr = await requireLogin()
        if (loginErr) return errorResult(loginErr)
        const p = await ensureBrowser()
        if (args.open_composer === true) {
          await p.locator('[aria-label="Send new message"]').click({ timeout: 5000 })
          await p.locator('input[placeholder="Type a name or phone number"], input[placeholder="Add recipients"]').first().waitFor({ timeout: 5000 })
        }
        let suggestionLabel: string | null = null
        if (typeof args.preview_number === 'string') {
          number(args.preview_number)
          const input = p.locator('input[placeholder="Type a name or phone number"]')
          if ((await chipNumbers(p)).length || await input.inputValue() || (await p.locator('textarea[placeholder="Type a message"]').inputValue()).length) return errorResult('Preview refused: composer is not empty')
          try {
            await input.fill(args.preview_number)
            const label = p.locator('.send-to-label')
            await label.waitFor({ timeout: 5000 })
            suggestionLabel = await label.innerText()
          } finally { await input.fill('') }
        }
        return textResult(JSON.stringify({
          suggestionLabel,
          normalizedSuggestion: suggestionLabel === null ? null : suggestionNumber(suggestionLabel),
          chips: await chipNumbers(p),
          recipientValues: await p.locator('input[placeholder="Type a name or phone number"], input[placeholder="Add recipients"]').evaluateAll(els => els.map(e => (e as HTMLInputElement).value)),
          messageLengths: await p.locator('textarea[placeholder="Type a message"], input[placeholder="Type a message"]').evaluateAll(els => els.map(e => (e as HTMLInputElement).value.length)),
          sendDisabled: await p.locator('button[aria-label="Send message"]').isDisabled({ timeout: 1000 }).catch(() => null),
        }))
      }
      // --- Login ---
      case 'gv_login': {
        // Launch system Chrome (not Playwright) to avoid Google's automation detection
        const chromePath = await launchLoginBrowser()
        if (process.platform === 'win32') return textResult('Google Voice Chrome window opened. Complete login and 2FA directly in that window, then call gv_check_login. Do not paste credentials into chat.');

        return textResult(
          `System Chrome (${chromePath}) launched with remote debugging on port ${REMOTE_DEBUG_PORT}.\n\n` +
          'To complete login interactively from your local machine:\n' +
          `1. Set up an SSH tunnel:  ssh -L ${REMOTE_DEBUG_PORT}:localhost:${REMOTE_DEBUG_PORT} <your-server>\n` +
          `2. Open Chrome and go to:  chrome://inspect/#devices\n` +
          `3. Click "Configure..." and add localhost:${REMOTE_DEBUG_PORT}\n` +
          '4. Click "inspect" on the Google Voice target\n' +
          '5. Complete Google login (including 2FA if prompted)\n' +
          '6. Once you see Google Voice Messages, call gv_check_login to verify.\n\n' +
          'Alternatively, set GOOGLEVOICE_DEBUG_PORT to use a different port.',
        )
      }

      case 'gv_check_login': {
        const loggedIn = await checkLoginStatus()
        if (loggedIn) {
          return textResult('Logged in to Google Voice. Sending remains subject to setup locks; account ownership must be confirmed by the user.')
        }
        return textResult(
          'Not logged in. Run gv_login to open a browser window and complete Google login.',
        )
      }

      // --- List SMS ---
      case 'gv_list_sms': {
        const loginErr = await requireLogin()
        if (loginErr) return errorResult(loginErr)

        const page = await ensureBrowser()
        const filter = (args.filter as string) === 'unread' ? 'unread' : 'all'
        const limit = Math.max(1, Math.min(Number(args.limit) || 20, 100))

        const conversations = await listSms(page, { filter, limit })
        if (conversations.length === 0) {
          return textResult(filter === 'unread' ? 'No unread SMS conversations.' : 'No SMS conversations found.')
        }
        return textResult(JSON.stringify(conversations, null, 2))
      }

      // --- Read Conversation ---
      case 'gv_read_sms': {
        const loginErr = await requireLogin()
        if (loginErr) return errorResult(loginErr)

        const conversationId = args.conversation_id as string
        if (!conversationId) return errorResult('conversation_id is required.')

        const page = await ensureBrowser()
        const limit = Math.max(1, Math.min(Number(args.limit) || 50, 200))
        const readFilter = (args.filter as string) === 'unread' ? 'unread' : 'all'
        const messages = await readConversation(page, conversationId, limit, readFilter)

        if (messages.length === 0) {
          return textResult('No messages found in this conversation.')
        }
        return textResult(JSON.stringify(messages, null, 2))
      }

      // --- Send SMS ---
      case 'gv_send_sms': {
        const loginErr = await requireLogin()
        if (loginErr) return errorResult(loginErr)

        const phoneNumber = args.phone_number as string
        const text = args.text as string
        if (typeof phoneNumber !== 'string' || typeof text !== 'string' || !text.trim()) return errorResult('phone_number and text are required.')

        const page = await ensureBrowser()
        const conversationId = await sendSms(page, phoneNumber, text)

        const recipients = phoneNumber
        return textResult(
          `SMS submitted to Google Voice for ${recipients}; delivery is not confirmed.` +
          (conversationId ? ` Conversation ID: ${conversationId}` : ''),
        )
      }

      // --- Reply SMS ---
      case 'gv_reply_sms': {
        const loginErr = await requireLogin()
        if (loginErr) return errorResult(loginErr)

        const conversationId = args.conversation_id as string
        const text = args.text as string
        if (!conversationId || !text) return errorResult('conversation_id and text are required.')

        const page = await ensureBrowser()
        await replySms(page, conversationId, text)

        return textResult(`Reply submitted to Google Voice for conversation ${conversationId}; delivery is not confirmed.`)
      }

      // --- Mark Read ---
      case 'gv_mark_read': {
        const loginErr = await requireLogin()
        if (loginErr) return errorResult(loginErr)

        const conversationId = args.conversation_id as string
        if (!conversationId) return errorResult('conversation_id is required.')

        const page = await ensureBrowser()
        await markAsRead(page, conversationId)

        return textResult(`Conversation ${conversationId} marked as read.`)
      }

      default:
        return errorResult(`Unknown tool: ${req.params.name}`)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`googlevoice: tool ${req.params.name} failed: ${msg}\n`)
    return errorResult(`Error: ${msg}`)
  }
})

// --- Test Mode ---

async function testMode() {
  const { checkLoginStatus } = await import('./browser.js')
  console.log('Checking login status...')
  const loggedIn = await checkLoginStatus()
  if (loggedIn) {
    console.log('Logged in to Google Voice.')
  } else {
    console.log('Not logged in. Run gv_login first.')
  }
  await import('./browser.js').then(m => m.closeBrowser())
  process.exit(0)
}

// --- Start Server ---

async function main() {
  if (process.argv.includes('--test')) {
    await testMode()
    return
  }
  const transport = new StdioServerTransport()
  await server.connect(transport)
  process.stderr.write('googlevoice: MCP server started\n')
}

main().catch((err) => {
  process.stderr.write(`googlevoice: fatal: ${err}\n`)
  process.exit(1)
})

// Cleanup on stdin close (MCP convention)
process.stdin.on('end', () => {
  closeBrowser().then(() => process.exit(0))
})

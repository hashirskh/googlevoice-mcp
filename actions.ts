import type { Page } from 'playwright'
import { SafeSender, number, sameText, suggestionNumber, type SendUI } from './safe-send.js'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
const stateDir = process.env.GOOGLEVOICE_STATE_DIR ?? join(homedir(), '.local', 'share', 'googlevoice')
const stopFile = join(stateDir, 'send-stopped')
const sender = new SafeSender(() => { mkdirSync(stateDir, { recursive: true }); const fd = openSync(stopFile, 'wx'); try { writeFileSync(fd, 'Human review required before another send. Do not automatically retry.\n') } finally { closeSync(fd) } })
export const CHIP_SELECTOR = '[aria-label="Select recipients"] mat-chip-row'
const REMOVE_CHIP = '[gv-test-id="chip-item-remove"]'
export const chipNumbers = (p: Page) => p.locator(CHIP_SELECTOR).evaluateAll((chips, removeSelector) => chips.map(chip => {
  const label = chip.querySelector(removeSelector)?.getAttribute('aria-label') ?? ''
  return /^Remove (\+?[\d() .-]+)\?$/.exec(label)?.[1]?.trim() ?? ''
}), REMOVE_CHIP)

import { SELECTORS } from './selectors.js'
import { navigateToMessages, navigateToConversation, VOICE_MESSAGES_URL } from './browser.js'
import type { SmsConversation, SmsMessage } from './types.js'

export async function listSms(
  page: Page,
  options: { filter: 'all' | 'unread'; limit: number },
): Promise<SmsConversation[]> {
  await navigateToMessages(page)

  await page.waitForSelector(SELECTORS.CONVERSATION_ITEM, { timeout: 10000 })

  // First pass: extract visible data and conversation IDs from all items.
  // Uses history.pushState interception to capture the conversation URL
  // without actually navigating — this avoids marking unread conversations as read.
  const rawItems = await page.$$eval(SELECTORS.CONVERSATION_ITEM, (els, sel) => {
    return els.map(el => {
      const container = el.querySelector(sel.clickable)
      const isUnread = !container?.classList.contains(sel.readClass)
      const contact = el.querySelector(sel.contact)?.textContent?.trim() || ''
      const snippet = el.querySelector(sel.snippet)?.textContent?.trim() || ''
      const timestamp = el.querySelector(sel.timestamp)?.textContent?.trim() || ''
      return { contact, snippet, timestamp, isUnread }
    })
  }, {
    clickable: SELECTORS.CONVERSATION_CLICKABLE,
    readClass: SELECTORS.CONVERSATION_READ_CLASS,
    contact: SELECTORS.CONVERSATION_CONTACT,
    snippet: SELECTORS.CONVERSATION_SNIPPET,
    timestamp: SELECTORS.CONVERSATION_TIMESTAMP,
  })

  // Filter and limit
  const filtered = rawItems
    .map((item, index) => ({ ...item, index }))
    .filter(item => options.filter === 'all' || item.isUnread)
    .slice(0, options.limit)

  // Read attributes only: clicking a thread can mark an unread message as read.
  const ids = await page.$$eval(SELECTORS.CONVERSATION_ITEM, els => els.map(el => {
    const href = el.querySelector('a[href]')?.getAttribute('href')
    if (href) return new URL(href, location.href).searchParams.get('itemId') || ''
    return el.getAttribute('data-item-id') || el.getAttribute('data-thread-id') || ''
  }))
  const conversations = filtered.map(item => ({ conversationId: ids[item.index] || '', contact: item.contact, lastMessage: item.snippet, lastTimestamp: item.timestamp, isUnread: item.isUnread }))

  return conversations
}

export async function readConversation(
  page: Page,
  conversationId: string,
  limit: number,
  filter: 'all' | 'unread' = 'all',
): Promise<SmsMessage[]> {
  if (filter === 'unread') {
    const unreadConversations = await listSms(page, { filter: 'unread', limit: 50 })
    const isUnread = unreadConversations.some(c => c.conversationId === conversationId)
    if (!isUnread) return []
  }

  await navigateToConversation(page, conversationId)

  await page.waitForSelector(SELECTORS.MESSAGE_BUBBLE, { timeout: 10000 })

  const bubbles = await page.$$(SELECTORS.MESSAGE_BUBBLE)
  const messages: SmsMessage[] = []

  const start = Math.max(0, bubbles.length - limit)
  for (let i = start; i < bubbles.length; i++) {
    const bubble = bubbles[i]

    const text = await bubble
      .$(SELECTORS.MESSAGE_TEXT)
      .then(el => el?.innerText() ?? '')
      .catch(() => '')

    const timestamp = await bubble
      .$(SELECTORS.MESSAGE_TIMESTAMP)
      .then(el => el?.innerText() ?? '')
      .catch(() => '')

    const isInbound = await bubble
      .$(SELECTORS.MESSAGE_INCOMING)
      .then(el => el !== null)
      .catch(() => false)

    const sender = isInbound ? 'contact' : 'me'

    messages.push({
      conversationId,
      sender,
      text: text.trim(),
      timestamp: timestamp.trim(),
      isUnread: false,
      isInbound,
    })
  }

  return messages
}


export async function sendSms(page: Page, phoneNumber: unknown, text: unknown): Promise<string> {
  number(phoneNumber)
  if (process.env.GOOGLEVOICE_ALLOW_WRITES !== '1' || process.env.GOOGLEVOICE_LIVE_CHIPS_VERIFIED !== '1') throw new Error('Sending disabled: setup and live recipient-chip verification required')
  if (existsSync(stopFile)) throw new Error('Sending stopped: previous attempt requires human review; never automatically retry')
  const chips = page.locator(CHIP_SELECTOR)
  const composer = page.locator(SELECTORS.COMPOSE_INPUT)
  const recipient = page.locator(SELECTORS.RECIPIENT_INPUT + ', input[placeholder="Add recipients"]')
  let beforeCount = 0
  const ui: SendUI = {
    async snapshot() {
      const inputs = await recipient.all()
      const texts = await composer.all()
      return { chips: await chipNumbers(page), recipient: (await Promise.all(inputs.map(i => i.inputValue()))).join(''), text: (await Promise.all(texts.map(i => i.inputValue()))).join('') }
    },
    async open() { await navigateToMessages(page); await page.locator(SELECTORS.NEW_CONVERSATION_BUTTON).click({ timeout: 5000 }) },
    async add(phone) {
      await page.locator(SELECTORS.RECIPIENT_INPUT).fill(phone)
      const suggestion = page.locator('.send-to-label')
      await suggestion.waitFor({ timeout: 5000 })
      if (suggestionNumber(await suggestion.innerText()) !== number(phone)) throw new Error('Recipient suggestion mismatch')
      await suggestion.click()
      await chips.first().waitFor({ state: 'visible', timeout: 5000 })
    },
    async fill(message) { beforeCount = await page.locator(SELECTORS.MESSAGE_BUBBLE).count(); await composer.fill(message) },
    async error() {
      const status = await page.locator('gv-message-list, [role="alert"], mat-snack-bar-container, .error').allTextContents()
      if (/not delivered|too many messages|failed to send|unable to send|couldn.t send|could not send|try again/i.test(status.join(' '))) throw new Error('Google Voice error detected')
    },
    async clickOnce() {
      // DOM click has no retry and no keyboard events. Reassert recipients/text in this same task.
      await page.evaluate(({ chipSelector, removeSelector, composeSelector, sendSelector, expectedPhone, expectedText }) => {
        const digits = (s: string) => { const d = s.replace(/\D/g, ''); return d.length === 10 ? '1'+d : d }
        const c = Array.from(document.querySelectorAll(chipSelector))
        const extra = Array.from(document.querySelectorAll('input[placeholder="Type a name or phone number"], input[placeholder="Add recipients"]')) as HTMLInputElement[]
        const inputs = document.querySelectorAll(composeSelector)
        const buttons = document.querySelectorAll(sendSelector)
        const label = c[0]?.querySelector(removeSelector)?.getAttribute('aria-label') ?? ''
        const phone = /^Remove (\+?[\d() .-]+)\?$/.exec(label)?.[1] ?? ''
        if (c.length !== 1 || digits(phone) !== expectedPhone || extra.some(i => i.value.trim()) || inputs.length !== 1 || (inputs[0] as HTMLTextAreaElement).value.replace(/\r\n/g,'\n') !== expectedText.replace(/\r\n/g,'\n') || buttons.length !== 1 || (buttons[0] as HTMLButtonElement).disabled) throw new Error('Final recipient/text/button verification failed')
        ;(buttons[0] as HTMLButtonElement).click()
      }, { chipSelector: CHIP_SELECTOR, removeSelector: REMOVE_CHIP, composeSelector: SELECTORS.COMPOSE_INPUT, sendSelector: SELECTORS.SEND_BUTTON, expectedPhone: number(phoneNumber), expectedText: text as string })
    },
    async confirmed(phone, message) {
      const intendedThread = (url: URL) => {
        const id = url.searchParams.get('itemId') ?? ''
        return url.origin === 'https://voice.google.com' && /^t\.\+?\d{10,11}$/.test(id) && number(id.slice(2)) === number(phone)
      }
      await page.waitForURL(intendedThread, { timeout: 12000 }).catch(() => { throw new Error('Intended one-to-one conversation unconfirmed') })
      const id = new URL(page.url()).searchParams.get('itemId') || ''
      if (!/^t\.\+?\d+$/.test(id) || number(id.slice(2)) !== number(phone)) throw new Error('Intended one-to-one conversation unconfirmed')
      const bubble = page.locator(SELECTORS.MESSAGE_BUBBLE).last()
      if (await page.locator(SELECTORS.MESSAGE_BUBBLE).count() <= beforeCount) throw new Error('No new message appeared after Send')
      if (await bubble.locator(SELECTORS.MESSAGE_INCOMING).count()) throw new Error('Last message is incoming')
      if (!sameText(await bubble.locator(SELECTORS.MESSAGE_TEXT).innerText(), message)) throw new Error('Submitted message not visible')
      if (await composer.inputValue()) throw new Error('Composer did not clear')
      return id
    },
    async abandon() { if (await composer.count() === 1) await composer.fill(''); await page.goto(VOICE_MESSAGES_URL, { waitUntil: 'load' }) },
    async refresh() { await page.goto(VOICE_MESSAGES_URL, { waitUntil: 'load' }) },
    async wait(ms) { await page.waitForTimeout(ms) },
  }
  const id = await sender.send(ui, phoneNumber, text)
  unlinkSync(stopFile)
  return id
}

export async function replySms(_page: Page, _conversationId: string, _text: string): Promise<void> {
  throw new Error('Reply disabled: use a separately authorized single phone number through guarded send')
}

export async function markAsRead(
  page: Page,
  conversationId: string,
): Promise<void> {
  await navigateToConversation(page, conversationId)
  await page.waitForTimeout(1000)

  try {
    const moreBtn = await page.$(SELECTORS.MORE_OPTIONS_BUTTON)
    if (moreBtn) {
      await moreBtn.click()
      await page.waitForTimeout(500)
      const markReadBtn = await page.$(SELECTORS.MARK_READ_OPTION)
      if (markReadBtn) {
        await markReadBtn.click()
      } else {
        await page.keyboard.press('Escape')
      }
    }
  } catch {
    // Opening the conversation already marked it as read
  }
}


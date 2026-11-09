# Google Voice MCP (Windows-capable adaptation)

An unofficial MCP server for Google Voice SMS. It provides tools to check login, list and read conversations, send and reply to SMS, and mark conversations read. Google Voice has no public SMS API for this use case; the server automates the Google Voice website through system Chrome and Playwright's Chrome DevTools Protocol connection. Google can change or restrict this behavior at any time.

This repository includes Windows Chrome discovery, localhost-only debugging, a write guard, and checks around multiline composition and visible send errors. See [LICENSE](LICENSE) for the applicable license.

## Requirements

- Node.js 18 or newer
- System Google Chrome or Chromium
- On Linux headless servers, Xvfb

Playwright is used as an automation library; the server runs your installed Chrome. Its browser profile contains your Google session and must stay private.

## Install from this repository

```sh
git clone https://github.com/hashirskh/googlevoice-mcp.git
cd googlevoice-mcp
npm ci --ignore-scripts
npm run build
```

`npm ci --ignore-scripts` avoids downloading Playwright's bundled browser. Install Chrome separately. To start the MCP server locally, run `node dist/server.js` from the repository directory. It communicates over stdio.

Set these environment variables in your MCP client:

| Name | Purpose |
| --- | --- |
| `GOOGLEVOICE_STATE_DIR` | Absolute path to a **private** local directory for the browser profile. Keep it outside the repository. |
| `GOOGLEVOICE_DEBUG_PORT` | A free localhost port, for example `19223`. |
| `GOOGLEVOICE_ALLOW_WRITES` | Leave unset or `0` while setting up. Set to `1` only when you intend to allow send, reply, and mark-read tools. |

Register the server in your MCP client with the absolute path to `node` and the absolute path to `dist/server.js`. For Codex, configure a local stdio MCP server named `googlevoice`; then restart the client or start a new chat. The npm package name is not unique to this Git repository, so `npx mcp-googlevoice` may run a different published package. Use the locally built server path when you want this version.

## Sign in

Call `gv_login`, then sign in to the intended Google account **directly in the dedicated Chrome window** and complete any Google verification there. Open `https://voice.google.com/u/0/messages` in that same browser profile and call `gv_check_login`. If several Google accounts are in the profile, verify which account Google Voice selected. Never paste passwords, verification codes, cookies, or your browser profile into an agent chat or Git repository.

On a remote Linux server, interactive login may require a localhost SSH tunnel and `chrome://inspect`. The remote debugging port must stay private; do not publish or forward it to an untrusted network.

## Tools

| Tool | Action |
| --- | --- |
| `gv_login` | Open system Chrome for interactive Google login |
| `gv_check_login` | Check whether the Google Voice inbox is accessible |
| `gv_list_sms` | List conversations |
| `gv_read_sms` | Read a conversation |
| `gv_send_sms` | Send a new SMS |
| `gv_reply_sms` | Reply to a conversation |
| `gv_mark_read` | Mark a conversation read |

Opening a conversation can itself change its read status. Before using `gv_list_sms` for unread messages, inspect whether the current Google Voice interface still preserves unread state during listing.

## Sending behavior and limits

The local changes fill the complete message without Enter keystrokes, verify the composed text before clicking Send once, and check visible Google Voice send errors. `gv_send_sms` can accept multiple recipients, which may create a group conversation; use one phone number per call for separate texts. A successful tool response means submission to the Google Voice interface, **not confirmed delivery**. Google Voice can reject, delay, or limit messages. Verify receipt or the conversation's status, and never automatically retry an uncertain send.

Do not commit `node_modules`, `dist`, state directories, browser profiles, cookies, or credentials. The included `.gitignore` excludes common local artifacts, but always review `git status` before publishing changes.



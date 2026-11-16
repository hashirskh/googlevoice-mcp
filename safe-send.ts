export const PAUSE_MS = 4000
export function suggestionNumber(label: string): string {
  const clean = label.replace(/[\u202A-\u202E\u2066-\u2069]/g, '').replace(/\u00a0/g, ' ').trim()
  if (!/^Send to\s+/i.test(clean)) throw new Error('Unrecognized recipient suggestion')
  return number(clean.replace(/^Send to\s+/i, '').trim())
}
export function number(value: unknown): string {
  if (typeof value !== 'string' || !/^\+?[\d() .-]+$/.test(value)) throw new Error('Exactly one phone number required; arrays refused')
  const digits = value.replace(/\D/g, '')
  if (!/^(1\d{10}|\d{10})$/.test(digits)) throw new Error('Exactly one US phone number required')
  return digits.length === 10 ? '1' + digits : digits
}
export const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n')
export type Snapshot = { chips: string[]; recipient: string; text: string }
export interface SendUI {
  snapshot(): Promise<Snapshot>; open(): Promise<void>; add(phone: string): Promise<void>;
  fill(text: string): Promise<void>; error(): Promise<void>; clickOnce(): Promise<void>;
  confirmed(phone: string, text: string): Promise<string>; abandon(): Promise<void>;
  refresh(): Promise<void>; wait(ms: number): Promise<void>;
}
export function assertRecipient(s: Snapshot, phone: string) {
  if (s.chips.length !== 1 || number(s.chips[0]) !== number(phone) || s.recipient.trim()) throw new Error('Extra, mismatched, or unverified recipient')
}
export class SafeSender {
  private busy = false
  private stopped = false
  constructor(private latch: () => void = () => {}) {}
  async send(ui: SendUI, phone: unknown, text: unknown): Promise<string> {
    number(phone)
    if (typeof text !== 'string' || !text.trim()) throw new Error('Nonempty message text required')
    if (this.busy || this.stopped) throw new Error('Sending stopped or busy; human review required, no automatic retry')
    this.busy = true
    let attempted = false
    let latched = false
    try {
      const clean = async () => {
        const s = await ui.snapshot()
        if (s.chips.length || s.recipient.trim() || s.text) throw new Error('Stale draft detected')
      }
      await clean() // Inspect before navigation can hide a stale draft.
      await ui.error()
      await ui.open()
      await clean()
      await ui.add(phone as string)
      assertRecipient(await ui.snapshot(), phone as string)
      await ui.fill(text)
      await ui.error()
      const final = await ui.snapshot()
      assertRecipient(final, phone as string)
      if (!sameText(final.text, text)) throw new Error('Complete message text mismatch')
      latched = true
      this.latch() // Persistent lock precedes the only send attempt, including process crashes.
      attempted = true
      await ui.clickOnce()
      await ui.error()
      const id = await ui.confirmed(phone as string, text)
      await ui.error()
      await ui.refresh()
      await ui.wait(PAUSE_MS)
      return id
    } catch (error) {
      this.stopped = true
      if (!latched) this.latch()
      if (!attempted) await ui.abandon().catch(() => {})
      throw new Error(`${attempted ? 'Outcome uncertain or send error; do not retry' : 'Aborted without Send; draft abandoned'}. ${String(error)}`)
    } finally { this.busy = false }
  }
}

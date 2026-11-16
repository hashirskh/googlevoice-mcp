import test from 'node:test'
import assert from 'node:assert/strict'
import { SafeSender, PAUSE_MS, suggestionNumber } from './dist/safe-send.js'
test('live Google Voice suggestion with invisible direction marks', () => {
  assert.equal(suggestionNumber('Send to \u202a(202) 555-0123\u202c'), '12025550123')
  assert.equal(suggestionNumber('Send to\u00a0\u2066(202) 555-0123\u2069'), '12025550123')
})
for (const invalid of ['Send to (202) 555-0123, (202) 555-0124', 'Send to Alice', '2025550123', 'Send to 2025550123 ext 2']) {
  test('suggestion still refuses '+invalid, () => assert.throws(() => suggestionNumber(invalid)))
}
const phone = '+12025550123', text = 'First line\nSecond line'
function fixture(overrides = {}) {
  let s = { chips: [], recipient: '', text: '' }, clicks = 0, abandoned = false
  const events = []
  const ui = {
    async snapshot() { return structuredClone(s) },
    async open() { events.push('open') },
    async add(p) { s.chips = [p] },
    async fill(t) { s.text = t; events.push('fill') },
    async error() {},
    async clickOnce() { clicks++; events.push('click') },
    async confirmed() { events.push('confirmed'); return 't.' + phone },
    async abandon() { abandoned = true },
    async refresh() { events.push('refresh') },
    async wait(ms) { events.push(ms) },
    ...overrides,
  }
  return { ui, events, get s() { return s }, get clicks() { return clicks }, get abandoned() { return abandoned } }
}
for (const invalid of [[phone], [phone, '+12025550124'], phone+',12025550124', 'abc2025550123', '', null]) {
  test('reject recipient input '+JSON.stringify(invalid), async () => {
    const f=fixture(); await assert.rejects(new SafeSender().send(f.ui,invalid,text)); assert.equal(f.clicks,0); assert.deepEqual(f.events,[])
  })
}
for (const draft of [{chips:[phone]}, {recipient:phone}, {text:'old draft'}]) {
  test('stale draft '+JSON.stringify(draft), async()=>{
    const f=fixture(); Object.assign(f.s,draft)
    await assert.rejects(new SafeSender().send(f.ui,phone,text),/Stale draft/)
    assert.equal(f.clicks,0); assert.equal(f.abandoned,true); assert.deepEqual(f.events,[])
  })
}
test('stale draft exposed on opening',async()=>{
  const f=fixture({async open(){f.s.chips=[phone]}})
  await assert.rejects(new SafeSender().send(f.ui,phone,text),/Stale draft/); assert.equal(f.clicks,0)
})
for (const chips of [[phone,phone],['+12025550124'],[],['Name without number']]) {
  test('extra or mismatched chips '+JSON.stringify(chips),async()=>{
    const f=fixture({async add(){f.s.chips=chips}})
    await assert.rejects(new SafeSender().send(f.ui,phone,text)); assert.equal(f.clicks,0); assert.equal(f.abandoned,true)
  })
}
test('recipient changes while filling',async()=>{
  const f=fixture({async fill(t){f.s.text=t;f.s.chips=['+12025550124']}})
  await assert.rejects(new SafeSender().send(f.ui,phone,text)); assert.equal(f.clicks,0)
})
test('extra uncommitted recipient at final check',async()=>{
  const f=fixture({async fill(t){f.s.text=t;f.s.recipient='+12025550124'}})
  await assert.rejects(new SafeSender().send(f.ui,phone,text)); assert.equal(f.clicks,0)
})
test('multiline preserved, clicked once, confirmation then refresh then four seconds',async()=>{
  const f=fixture(); const sender=new SafeSender()
  assert.equal(await sender.send(f.ui,phone,text),'t.'+phone)
  assert.equal(f.s.text,text); assert.equal(f.clicks,1)
  assert.deepEqual(f.events,['open','fill','click','confirmed','refresh',4000]); assert.ok(PAUSE_MS>=3000&&PAUSE_MS<=5000)
})
test('truncated multiline aborts before click',async()=>{
  const f=fixture({async fill(){f.s.text='First line'}})
  await assert.rejects(new SafeSender().send(f.ui,phone,text),/text mismatch/);assert.equal(f.clicks,0)
})
for (const stage of ['pre','final','post']) {
  test('Google Voice error '+stage,async()=>{
    let checks=0
    const f=fixture({async error(){checks++;if(checks===({pre:1,final:2,post:3}[stage]))throw Error('Google Voice error')}})
    const sender=new SafeSender()
    await assert.rejects(sender.send(f.ui,phone,text),/Google Voice error/)
    assert.equal(f.clicks,stage==='post'?1:0)
    await assert.rejects(sender.send(f.ui,phone,text),/human review/)
  })
}
for (const stage of ['clickOnce','confirmed','refresh','wait']) {
  test('uncertain '+stage+' stops retries',async()=>{
    let attempts=0,latches=0
    const f=fixture({async [stage](){attempts++;throw Error('timeout')}})
    const sender=new SafeSender(()=>latches++)
    await assert.rejects(sender.send(f.ui,phone,text),/do not retry/)
    await assert.rejects(sender.send(f.ui,phone,text),/human review/)
    assert.equal(attempts,1);assert.ok(latches>=1);assert.equal(f.abandoned,false)
  })
}
test('overlapping recipient calls rejected during refresh pause',async()=>{
  let release, reached
  const ready=new Promise(r=>reached=r)
  const f=fixture({async wait(){reached();await new Promise(r=>release=r)}})
  const sender=new SafeSender();const first=sender.send(f.ui,phone,text)
  await ready;await assert.rejects(sender.send(f.ui,'+12025550124',text),/busy/)
  release();await first;assert.equal(f.clicks,1)
})

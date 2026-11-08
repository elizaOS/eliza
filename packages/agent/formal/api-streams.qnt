// Backup response backpressure, cancellation, and terminal receipt ordering.
// One representative stream, two data frames and one terminal frame.
// SSE token replacement and event replay are ordering abstractions, not text proofs.
module api_streams {
  var s: { sent: int, flushed: int, blocked: bool, cancelled: bool, ended: bool, text: int, provisional: bool, cursor: int, event: int }
  action init = s' = { sent: 0, flushed: 0, blocked: false, cancelled: false, ended: false, text: 0, provisional: false, cursor: 0, event: 0 }
  action write = all { not(s.cancelled), not(s.ended), not(s.blocked), s.sent == s.flushed, s.sent < 3, s' = s.with("sent", s.sent + 1).with("blocked", true) }
  action flush = all { not(s.cancelled), s.blocked, s' = s.with("flushed", s.sent).with("blocked", false) }
  action cancel = all { not(s.ended), s' = s.with("cancelled", true) }
  action end = all { not(s.cancelled), s.sent == 3, s.flushed == 3, not(s.blocked), s' = s.with("ended", true) }
  action provisional = all { s.text < 2, s' = s.with("text", s.text + 1).with("provisional", true) }
  action authoritative = s' = s.with("text", 2).with("provisional", false)
  action publishEvent = all { s.event < 3, s' = s.with("event", s.event + 1) }
  action replay = all { s.cursor < s.event, s' = s.with("cursor", s.event) }
  action idle = s' = s
  action step = any { write, flush, cancel, end, provisional, authoritative, publishEvent, replay, idle }
  val safety = all { s.flushed <= s.sent, s.sent <= s.flushed + 1, s.ended implies (not(s.cancelled) and s.flushed == 3), s.cursor <= s.event, s.cursor >= 0 }
  run cancelDuringBackpressureTest = init.then(write).then(cancel).expect(not(s.ended) and s.sent == 1 and s.flushed == 0)
  run terminalFrameMustFlushTest = init.then(write).then(flush).then(write).then(flush).then(write).then(flush).then(end).expect(s.ended)
  run replacementEndsProvisionalTextTest = init.then(provisional).then(authoritative).expect(s.text == 2 and not(s.provisional))
}

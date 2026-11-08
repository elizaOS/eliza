// Native gateway owner/reset fencing and pull acknowledgement.
// Buffered text is retained until cursor acknowledgement; reset destroys old authority.
module api_native_gateway {
  var s: { epoch: int, captured: int, pending: bool, owner: int, capturedOwner: int, seq: int, ack: int, done: bool, delivered: bool }
  action init = s' = { epoch: 0, captured: -1, pending: false, owner: 1, capturedOwner: 0, seq: 0, ack: 0, done: false, delivered: false }
  action admit = all { not(s.pending), s' = s.with("pending", true).with("captured", s.epoch).with("capturedOwner", s.owner).with("seq", 0).with("ack", 0).with("done", false).with("delivered", false) }
  action token = all { s.pending, s.seq < 3, not(s.done), s' = s.with("seq", s.seq + 1) }
  action acknowledge = all { s.pending, s.captured == s.epoch, s.capturedOwner == s.owner, s.ack < s.seq, s' = s.with("ack", s.seq) }
  action complete = all { s.pending, s' = s.with("done", true) }
  action deliver = all { s.pending, s.done, s.captured == s.epoch, s.capturedOwner == s.owner, s' = s.with("delivered", true).with("pending", false) }
  action reset = all { s.epoch < 2, s' = s.with("epoch", s.epoch + 1).with("pending", false).with("seq", 0).with("ack", 0).with("done", false).with("delivered", false) }
  action rotate = all { s.owner == 1, s' = s.with("owner", 2).with("delivered", false) }
  action idle = s' = s
  action step = any { admit, token, acknowledge, complete, deliver, reset, rotate, idle }
  val safety = all { s.ack <= s.seq, s.ack >= 0, s.delivered implies (s.done and s.captured == s.epoch and s.capturedOwner == s.owner), s.seq <= 3 }
  run resetDropsInflightReplyTest = init.then(admit).then(token).then(reset).expect(not(s.pending) and not(s.delivered) and s.seq == 0)
  run acknowledgedPrefixRetiredTest = init.then(admit).then(token).then(token).then(acknowledge).expect(s.ack == 2 and s.ack == s.seq)
  run oldAccountCannotReceiveReplyTest = init.then(admit).then(complete).then(rotate).expect(not(s.delivered))
}

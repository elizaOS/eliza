// Server resources: establish the close promise before invoking user disposers.
// One resource with a reentrant close; a late registration must be rejected.
module api_resources {
  var s: { closing: bool, disposed: int, entered: bool, lateAdmission: bool }
  action init = s' = { closing: false, disposed: 0, entered: false, lateAdmission: false }
  action close = all { not(s.closing), s' = s.with("closing", true) }
  action dispose = all { s.closing, not(s.entered), s' = s.with("entered", true).with("disposed", s.disposed + 1) }
  action reenter = all { s.entered, s.closing, s' = s }
  action add = all { not(s.closing), s' = s }
  action legacyDispose = all { not(s.closing), not(s.entered), s' = s.with("entered", true).with("disposed", 1) }
  action legacyReenter = all { s.entered, not(s.closing), s.disposed < 2, s' = s.with("disposed", s.disposed + 1).with("lateAdmission", true) }
  action idle = s' = s
  action step = any { close, dispose, reenter, add, idle }
  action legacyStep = any { step, legacyDispose, legacyReenter }
  val safety = all { s.disposed <= 1, not(s.lateAdmission), s.entered implies s.closing }
  run reentrantCloseDisposesOnceTest = init.then(close).then(dispose).then(reenter).expect(s.disposed == 1 and safety)
  run legacyReentrancyViolationTest = init.then(legacyDispose).then(legacyReenter).expect(not(safety))
}

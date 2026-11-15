// scripts/run-vitest-batches.ts: bounded subprocess ownership and JUnit publication.
// Two batches abstract any finite discovered suite. Individual tests, process OS
// delivery and XML parsing are delegated to the owning integration tests.
module tooling_batches {
  var s: { queued: int, running: int, passed: int, failed: int, cancelled: bool, done: bool, evidence: bool }
  action init = s' = { queued: 2, running: 0, passed: 0, failed: 0, cancelled: false, done: false, evidence: false }
  action launch = all { not(s.cancelled or s.done), s.queued > 0, s.running < 2, s' = s.with("queued", s.queued - 1).with("running", s.running + 1) }
  action pass = all { s.running > 0, s' = s.with("running", s.running - 1).with("passed", s.passed + 1) }
  action failure = all { s.running > 0, s' = s.with("running", s.running - 1).with("failed", s.failed + 1) }
  action interrupt = all { not(s.done), s' = s.with("cancelled", true) }
  action finish = all { not(s.done), s.running == 0, s.queued == 0 or s.cancelled, s' = s.with("done", true).with("evidence", not(s.cancelled) and s.failed == 0) }
  action idle = s' = s
  action step = any { launch, pass, failure, interrupt, finish, idle }
  val safety = all { s.queued >= 0, s.running >= 0, s.running <= 2, s.passed >= 0, s.failed >= 0, s.queued + s.running + s.passed + s.failed == 2, s.evidence implies s.done and not(s.cancelled) and s.passed == 2 }
  run failedBatchDoesNotPublishTest = init.then(launch).then(failure).then(launch).then(pass).then(finish).expect(s.done and not(s.evidence))
  run interruptedRunDrainsChildrenTest = init.then(launch).then(interrupt).then(failure).then(finish).expect(s.done and s.queued == 1 and not(s.evidence))
  run completeEvidenceTest = init.then(launch).then(launch).then(pass).then(pass).then(finish).expect(s.evidence)
}

/// Explicit selection, host-current persistence and terminal prompt outcomes.
module prompt_delivery {
  var s: { epoch: int, captured: int, requested: int, active: int,
    present: Set[int], owned: Set[int], phase: int, result: int, verified: bool,
    roomValid: bool, persisted: bool, outcome: int, delivered: bool, runStatus: int }
  action init = s' = {epoch: 0, captured: 0, requested: 0, active: 2,
    present: Set(1, 2), owned: Set(1, 2), phase: 0, result: 0, verified: false,
    roomValid: false, persisted: false, outcome: 0, delivered: false, runStatus: 0}
  action start(id: int): bool = all {s.phase == 0, id.in(0.to(2)),
    s' = {...s, captured: s.epoch, requested: id, phase: 1}}
  action switchWindow = all {s.phase == 1, s' = {...s, active: 3 - s.active}}
  action remove(id: int): bool = all {s.phase.in(Set(1, 2)), id.in(1.to(2)),
    s' = {...s, present: s.present.exclude(Set(id))}}
  action changeOwner(id: int): bool = all {s.phase == 1, id.in(1.to(2)),
    s' = {...s, owned: s.owned.exclude(Set(id))}}
  action replaceRuntime = all {s.phase.in(Set(1, 2, 3)), s.epoch == 0,
    s' = {...s, epoch: 1}}
  action resolve = all {
    s.phase == 1,
    val target = if (s.requested == 0) s.active else s.requested
    val accepted = s.epoch == s.captured and s.present.contains(target) and s.owned.contains(target)
    s' = {...s, phase: 2, result: if (accepted) target else -1, verified: accepted},
  }
  action readRoom = all {s.phase == 2,
    s' = {...s, phase: 3, roomValid: s.present.contains(s.result)}}
  action persist = all {s.phase == 3,
    s' = {...s, phase: 4, persisted: s.verified and s.roomValid and s.epoch == s.captured}}
  // 1 = completed, 2 = failed, 3 = cancelled, 4 = denied. Delivery can precede any result.
  action finishTurn(outcome: int, delivered: bool): bool = all {
    s.phase == 4, s.persisted, outcome.in(1.to(4)),
    s' = {...s, phase: 5, outcome: outcome, delivered: delivered,
      runStatus: if (outcome == 1) 1 else -1}}
  action step = any {nondet id = 0.to(2).oneOf() start(id), switchWindow,
    nondet id = 1.to(2).oneOf() remove(id),
    nondet id = 1.to(2).oneOf() changeOwner(id), replaceRuntime, resolve, readRoom, persist,
    nondet outcome = 1.to(4).oneOf() nondet delivered = Set(false, true).oneOf() finishTurn(outcome, delivered),
    s' = s}
  val safety = all {
    s.result > 0 implies (s.verified and (s.requested == 0 or s.result == s.requested)),
    s.persisted implies (s.verified and s.roomValid and s.epoch == s.captured),
    s.runStatus == 1 implies s.outcome == 1,
    s.runStatus == -1 implies s.outcome.in(Set(2, 3, 4))
  }
  run selectedWindowTest = init.then(start(1)).then(switchWindow).then(resolve).then(readRoom).then(persist)
    .expect(s.result == 1 and s.persisted and safety)
  run noFallbackTest = init.then(start(1)).then(remove(1)).then(resolve).then(readRoom).then(persist)
    .expect(s.result == -1 and not(s.persisted) and safety)
  run ownerChangeTest = init.then(start(1)).then(changeOwner(1)).then(resolve)
    .expect(s.result == -1 and safety)
  run runtimeChangeTest = init.then(start(1)).then(replaceRuntime).then(resolve)
    .expect(s.result == -1 and safety)
  run retiredAfterReadTest = init.then(start(1)).then(resolve).then(readRoom).then(replaceRuntime).then(persist)
    .expect(not(s.persisted) and safety)
  run failedAfterDeliveryTest = init.then(start(1)).then(resolve).then(readRoom).then(persist).then(finishTurn(2, true))
    .expect(s.delivered and s.runStatus == -1 and safety)
  run completedWithoutReplyTest = init.then(start(1)).then(resolve).then(readRoom).then(persist).then(finishTurn(1, false))
    .expect(not(s.delivered) and s.runStatus == 1 and safety)
}

/// An explicit owner conversation never falls back to another active window.
module prompt_delivery {
  var s: { epoch: int, captured: int, requested: int, active: int,
    present: Set[int], owned: Set[int], phase: int, result: int, verified: bool }
  action init = s' = {epoch: 0, captured: 0, requested: 0, active: 2,
    present: Set(1, 2), owned: Set(1, 2), phase: 0, result: 0, verified: false}
  action start(id: int): bool = all {s.phase == 0, id.in(0.to(2)),
    s' = {...s, captured: s.epoch, requested: id, phase: 1}}
  action switchWindow = all {s.phase == 1, s' = {...s, active: 3 - s.active}}
  action remove(id: int): bool = all {s.phase == 1, id.in(1.to(2)),
    s' = {...s, present: s.present.exclude(Set(id))}}
  action changeOwner(id: int): bool = all {s.phase == 1, id.in(1.to(2)),
    s' = {...s, owned: s.owned.exclude(Set(id))}}
  action replaceRuntime = all {s.phase == 1, s.epoch == 0,
    s' = {...s, epoch: 1}}
  action resolve = all {
    s.phase == 1,
    val target = if (s.requested == 0) s.active else s.requested
    val accepted = s.epoch == s.captured and s.present.contains(target) and s.owned.contains(target)
    s' = {...s, phase: 2, result: if (accepted) target else -1, verified: accepted},
  }
  action step = any {nondet id = 0.to(2).oneOf() start(id), switchWindow,
    nondet id = 1.to(2).oneOf() remove(id),
    nondet id = 1.to(2).oneOf() changeOwner(id), replaceRuntime, resolve, s' = s}
  val safety = s.result > 0 implies
    (s.verified and (s.requested == 0 or s.result == s.requested))
  run selectedWindowTest = init.then(start(1)).then(switchWindow).then(resolve)
    .expect(s.result == 1 and safety)
  run noFallbackTest = init.then(start(1)).then(remove(1)).then(resolve)
    .expect(s.result == -1 and safety)
  run ownerChangeTest = init.then(start(1)).then(changeOwner(1)).then(resolve)
    .expect(s.result == -1 and safety)
  run runtimeChangeTest = init.then(start(1)).then(replaceRuntime).then(resolve)
    .expect(s.result == -1 and safety)
}

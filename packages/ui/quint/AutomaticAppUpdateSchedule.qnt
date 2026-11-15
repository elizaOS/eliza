// Foreground timer and bridge-call ownership. Native package admission and
// network success remain separate environmental obligations.
module AutomaticAppUpdateSchedule {
  type State = {active: bool, disposed: bool, busy: bool, failures: int, wakeAt: int, valid: bool}
  var state: State
  var now: int
  action init = all {
    now' = 0,
    state' = {active:false, disposed:false, busy:false, failures:0, wakeAt:0, valid:true}
  }
  action active(value: bool): bool = all {
    now' = now,
    state' = if (state.disposed) state else {...state, active:value,
      valid: if (state.busy and state.active != value) false else state.valid}
  }
  action advance(value: int): bool = all {value >= now, value <= 20, now' = value, state' = state}
  action begin = all {
    state.active, not(state.disposed), not(state.busy), now >= state.wakeAt,
    now' = now, state' = {...state, busy:true, valid:true}
  }
  action finish(failed: bool): bool = all {
    state.busy,
    now' = now,
    val failures = if (failed) if (state.failures < 20) state.failures + 1 else 20 else 0
    val delay = if (not(failed) or failures >= 3) 4 else if (failures == 2) 2 else 1
    state' = {...state, busy:false, failures:failures, valid:true,
      wakeAt: if (not(state.valid)) now else now + delay}
  }
  action complete = any {finish(true), finish(false)}
  action dispose = all {
    now' = now,
    state' = {...state, disposed:true, active:false, valid:not(state.busy)}
  }
  val safety = state.failures >= 0 and state.failures <= 20 and
    (not(state.disposed) or not(state.active)) and
    (state.busy or state.valid) and state.wakeAt >= 0 and state.wakeAt <= 24 and
    now >= 0 and now <= 20
  action step = any {
    active(true), active(false), begin, complete, dispose,
    nondet time = 0.to(20).oneOf(); advance(time),
    all {state'=state, now'=now}
  }
  // A pending host operation can settle with success or failure. Backgrounding
  // and disposal retire authority but do not invent its completion.
  temporal FairCompletionSettles = complete.weakFair(state) implies
    always(state.busy implies eventually(not(state.busy)))
  // A continuously enabled due timer eventually runs, unless its foreground
  // owner is explicitly retired. Time advancement itself is not assumed fair.
  temporal FairDueTimerStarts = begin.weakFair(state) implies
    always((state.active and not(state.disposed) and not(state.busy) and now >= state.wakeAt)
      implies eventually(state.busy or not(state.active) or state.disposed))
  // Negative check: a bridge that never settles can hold the single operation.
  temporal UnconditionalCompletion = always(state.busy implies eventually(not(state.busy)))

  run staysForegroundAndFindsLaterReleaseTest = init.then(active(true)).then(begin).then(finish(false))
    .then(advance(3)).expect(now < state.wakeAt).then(advance(4)).then(begin).then(finish(false))
    .expect(safety and state.wakeAt == 8)
  run offlineRetriesAreBoundedAndRecoverTest = init.then(active(true)).then(begin).then(finish(true))
    .then(advance(1)).then(begin).then(finish(true)).then(advance(3)).then(begin).then(finish(true))
    .expect(state.wakeAt == 7).then(advance(7)).then(begin).then(finish(false))
    .expect(safety and state.failures == 0 and state.wakeAt == 11)
  run backgroundInvalidatesBeforeLaterEffectTest = init.then(active(true)).then(begin)
    .then(active(false)).then(active(true)).expect(not(state.valid) and state.busy)
    .then(finish(false)).expect(safety and state.wakeAt == 0)
    .then(begin).then(finish(false)).expect(state.wakeAt == 4)
  run disposedInFlightCannotAcquireAnotherAttemptTest = init.then(active(true)).then(begin)
    .then(dispose).expect(not(state.valid)).then(finish(true)).then(active(true))
    .expect(safety and state.disposed and not(state.active))
}

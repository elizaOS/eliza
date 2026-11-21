// BrowserSurfacePlugin.createSurface owns the protected profile and browser port.
// BrowserLoginFields and BrowserAutofillEligibility own the engine-attested field port.
module ManualSignInSurface {
  type State = {
    protectedOpen: bool, shown: bool, resumed: bool, committed: bool,
    exactOrigin: bool, fieldBound: bool, userChose: bool, filled: bool,
    ordinaryCapturing: bool, captureReleased: bool
  }

  var state: State

  action init = state' = {
    protectedOpen: false, shown: false, resumed: true, committed: false,
    exactOrigin: false, fieldBound: false, userChose: false, filled: false,
    ordinaryCapturing: false, captureReleased: false
  }

  action open(isolatedProcess: bool, isolatedStorage: bool, attestedFields: bool): bool = all {
    not(state.protectedOpen), isolatedProcess, isolatedStorage, attestedFields,
    state' = { ...state, protectedOpen: true, ordinaryCapturing: false, captureReleased: false }
  }
  action show(value: bool): bool = all {
    state.protectedOpen,
    state' = { ...state, shown: value, fieldBound: state.fieldBound and value,
      userChose: state.userChose and value, filled: false }
  }
  action activityResumed(value: bool): bool =
    state' = { ...state, resumed: value, filled: false }
  action commit(exact: bool): bool = all {
    state.protectedOpen,
    state' = { ...state, committed: true, exactOrigin: exact,
      fieldBound: false, userChose: false, filled: false }
  }
  action startNavigation = all {
    state.protectedOpen,
    state' = { ...state, committed: false, exactOrigin: false,
      fieldBound: false, userChose: false, filled: false }
  }
  action focus = all {
    state.protectedOpen, state.shown, state.resumed, state.committed, state.exactOrigin,
    state' = { ...state, fieldBound: true, userChose: false, filled: false }
  }
  action nativeChoice = all {
    state.fieldBound,
    state' = { ...state, userChose: true }
  }
  action fill = all {
    state.fieldBound, state.resumed, state.userChose,
    state' = { ...state, filled: true, userChose: false }
  }
  action cancelChoice = all {
    state.fieldBound,
    state' = { ...state, fieldBound: false, userChose: false, filled: false }
  }
  action settleChoice = any { fill, all { state.userChose, cancelChoice } }

  action close = state' = { ...state, protectedOpen: false, shown: false,
    committed: false, exactOrigin: false, fieldBound: false, userChose: false, filled: false }
  action startOrdinaryCapture = all {
    not(state.protectedOpen),
    state' = { ...state, ordinaryCapturing: true, captureReleased: false }
  }
  action releaseOrdinaryCapture = all {
    state.ordinaryCapturing, not(state.protectedOpen),
    state' = { ...state, ordinaryCapturing: false, captureReleased: true }
  }

  action step = any {
    open(true, true, true), show(true), show(false), activityResumed(true),
    activityResumed(false), commit(true), commit(false), startNavigation, focus, nativeChoice,
    settleChoice, cancelChoice, close, startOrdinaryCapture, releaseOrdinaryCapture, state' = state
  }

  val FieldNeedsCurrentExactDocument = state.fieldBound implies
    state.protectedOpen and state.shown and state.committed and state.exactOrigin
  val FilledNeedsCurrentForeground = state.filled implies state.fieldBound and state.resumed
  val ProtectedSurfaceBlocksCapture = state.protectedOpen implies
    not(state.ordinaryCapturing or state.captureReleased)

  temporal PendingChoiceSettles = settleChoice.weakFair(state).implies(
    always(state.userChose implies eventually(not(state.userChose))))

  run exactFillTest = init.then(open(true, true, true)).then(show(true)).then(commit(true))
    .then(focus).then(activityResumed(false)).then(nativeChoice).then(activityResumed(true))
    .then(fill).expect(state.filled and not(state.userChose))
  run wrongOriginTest = init.then(open(true, true, true)).then(show(true)).then(commit(false))
    .expect(not(state.fieldBound) and not(state.filled))
  run staleChoiceTest = init.then(open(true, true, true)).then(show(true)).then(commit(true))
    .then(focus).then(nativeChoice).then(startNavigation).then(commit(true))
    .expect(not(state.userChose) and not(state.fieldBound))
  run interruptedCaptureTest = init.then(startOrdinaryCapture).then(open(true, true, true))
    .then(close).expect(not(state.ordinaryCapturing or state.captureReleased))
}

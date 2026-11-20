// One turn of the opt-in secret swap (ELIZA_SECRET_SWAP_ENABLED).
// SecretSwapSession (packages/core/src/security/secret-swap.ts) numbers every
// known secret (environment and character secrets) when the turn's session is
// created, before any prompt is substituted. Every reference of the session
// carries the same nonce. A model call writes a reference for each value its
// prompt contains, so the model sees those references and the nonce.
// executePlannedToolCall (packages/core/src/runtime/execute-planned-tool-call.ts)
// restores the references in action arguments with failOnUnresolved: the
// handler gets the real value, or the call fails before the handler runs.
// The boundary restores only a reference this session wrote into model input.
// value: 0 and 1 are known credentials the session numbered at creation;
// 2 is a phone number the user typed, numbered when a prompt first shows it;
// 3 is a reference with the session's nonce and an index the session never
// numbered. Once any reference is shown, the model may write any of the four
// into an action argument.
module SecretReferenceExposure {
  pure val Values = 0.to(3)
  pure val Shown = 0.to(2)
  pure val NoCall = -1
  // outcome: 0 nothing executed yet, 1 the handler ran with the restored value,
  // 2 the boundary rejected the call before the handler.
  var exposed: Set[int]
  var call: int
  var lastRef: int
  var lastExposed: bool
  var outcome: int
  var received: Set[int]

  action init = all {
    exposed' = Set(), call' = NoCall, lastRef' = NoCall,
    lastExposed' = false, outcome' = 0, received' = Set()
  }
  // A model call whose prompt shows the values in `values`.
  action prompt(values: Set[int]): bool = all {
    call == NoCall,
    values.size() > 0,
    exposed' = exposed.union(values),
    call' = call, lastRef' = lastRef, lastExposed' = lastExposed,
    outcome' = outcome, received' = received
  }
  // The model writes one reference into an action argument. It knows the
  // nonce only after the session showed it a reference.
  action plan(ref: int): bool = all {
    call == NoCall,
    exposed.size() > 0,
    call' = ref,
    exposed' = exposed, lastRef' = lastRef, lastExposed' = lastExposed,
    outcome' = outcome, received' = received
  }
  action execute = {
    val restored = exposed.contains(call)
    all {
      call != NoCall,
      lastRef' = call, lastExposed' = restored,
      outcome' = if (restored) 1 else 2,
      received' = if (restored) received.union(Set(call)) else received,
      call' = NoCall, exposed' = exposed
    }
  }
  // The planner may stop before it executes the call.
  action stutter = all {
    exposed' = exposed, call' = call, lastRef' = lastRef,
    lastExposed' = lastExposed, outcome' = outcome, received' = received
  }
  action step = any {
    { nondet values = Shown.powerset().oneOf()
      prompt(values) },
    { nondet ref = Values.oneOf()
      plan(ref) },
    execute,
    stutter,
  }

  val ModelState = { exposed: exposed, call: call, lastRef: lastRef,
    lastExposed: lastExposed, outcome: outcome, received: received }
  temporal CallSettlesWithoutFairness = (call != NoCall).leadsTo(call == NoCall)
  temporal CallSettles = execute.weakFair(ModelState)
    .implies(CallSettlesWithoutFairness)

  val HandlerGetsOnlyShownValues = received.subseteq(exposed)
  val UnshownCredentialStaysPrivate =
    Set(0, 1).forall(c => exposed.contains(c) or not(received.contains(c)))
  val ShownReferenceRestores = outcome != 1 or lastExposed
  val UnshownReferenceRejected = outcome != 2 or not(lastExposed)
  val UnnumberedNeverRestores = not(received.contains(3)) and not(exposed.contains(3))
  val TypeOK = all {
    exposed.subseteq(Shown),
    call == NoCall or Values.contains(call),
    lastRef == NoCall or Values.contains(lastRef),
    Set(0, 1, 2).contains(outcome),
    (outcome == 0) == (lastRef == NoCall),
    received.subseteq(Values),
  }

  run unshownCredentialRejectedTest = init.then(prompt(Set(2))).then(plan(0))
    .then(execute)
    .expect(outcome == 2 and not(received.contains(0)))
  run shownCredentialRestoresTest = init.then(prompt(Set(1, 2))).then(plan(1))
    .then(execute)
    .expect(outcome == 1 and received == Set(1))
  run laterPromptShowsCredentialTest = init.then(prompt(Set(2))).then(plan(0))
    .then(execute).then(prompt(Set(0))).then(plan(0)).then(execute)
    .expect(outcome == 1 and received == Set(0))
  run unnumberedReferenceRejectedTest = init.then(prompt(Set(0, 1, 2)))
    .then(plan(3)).then(execute)
    .expect(outcome == 2 and received == Set())
}

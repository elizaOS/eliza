// The native request ID belongs to a dispatched operation. A cancellation
// acknowledgement only covers the request captured by that cancellation.
module NativeSignInController {
  pure val Requests = Set(1, 2)
  pure val NoCleanup = { request: 0, state: "none", intent: "none" }
  pure val NoReceipt = { request: 0, before: 0, after: 0 }

  type Cleanup = { request: int, state: str, intent: str }
  type Receipt = { request: int, before: int, after: int }
  type State = {
    mounts: int, mounted: bool, issued: int,
    request: int, phase: str, native: int,
    cleanup: Cleanup, detached: Set[int], receipt: Receipt
  }
  var s: State

  action init = s' = {
    mounts: 1, mounted: true, issued: 0,
    request: 0, phase: "methods", native: 0,
    cleanup: NoCleanup, detached: Set(), receipt: NoReceipt
  }

  action reopen = all {
    not(s.mounted), s.mounts < 2,
    s' = { ...s, mounts: s.mounts + 1, mounted: true, phase: "methods" }
  }

  // Host admission may be held before the controller allocates a request ID.
  action queueMethod = all {
    s.mounted, s.phase == "methods", s.issued < 2,
    s.cleanup.state != "waiting",
    s.request == 0 or s.cleanup.state == "failed",
    s' = { ...s, phase: "queued",
      cleanup: if (s.cleanup.state == "failed")
        { ...s.cleanup, state: "waiting", intent: "dispatch" }
        else NoCleanup }
  }

  action admitMethod = {
    val request = s.issued + 1
    all {
      s.mounted, s.phase == "queued", s.request == 0, s.cleanup == NoCleanup,
      s' = { ...s, issued: request, request: request,
        // The Android port refuses admission while another request owns its slot.
        phase: if (s.native == 0) "native" else "methods",
        native: if (s.native == 0) request else s.native }
    }
  }

  action rejectAdmission = all {
    s.mounted, s.phase == "queued", s.request == 0, s.cleanup == NoCleanup,
    s' = { ...s, phase: "methods" }
  }

  // The renderer promise may return or be fenced while native still owns its
  // request. The native picker can also end while a cancel reply is in flight.
  action nativeReply = all {
    s.phase == "native", s.cleanup == NoCleanup,
    s' = { ...s, phase: "methods" }
  }

  action nativeEnds = all {
    s.native != 0,
    s' = { ...s, native: 0 }
  }

  pure def scopeCancel(native: int, request: int): int =
    if (native == request) 0 else native

  action beginCleanup(intent: str): bool = all {
    s.mounted, s.cleanup.state != "waiting",
    intent != "abort" or Set("queued", "native").contains(s.phase),
    s' = if (s.request == 0)
      { ...s, mounted: intent != "leave", phase: "methods" }
      else { ...s, phase: "methods",
        cleanup: { request: s.request, state: "waiting", intent: intent } }
  }

  action cleanupReply(request: int, acknowledged: bool): bool = {
    val nextNative = scopeCancel(s.native, request)
    all {
      s.cleanup.state == "waiting", s.cleanup.request == request,
      s' = if (acknowledged) { ...s, request: 0, native: nextNative,
        receipt: { request: request, before: s.native, after: nextNative },
        mounted: s.cleanup.intent != "leave",
        cleanup: NoCleanup }
        else { ...s, phase: "methods", cleanup: { ...s.cleanup, state: "failed" } }
    }
  }

  // Teardown shares the in-flight cancellation. It does not wait before the
  // successor mounts, and sends nothing if this renderer never dispatched.
  action dispose = all {
    s.mounted,
    s' = { ...s, mounted: false, request: 0, phase: "methods",
      cleanup: NoCleanup,
      detached: if (s.request == 0) s.detached else s.detached.union(Set(s.request)) }
  }

  action detachedReply(request: int, acknowledged: bool): bool = {
    val nextNative = scopeCancel(s.native, request)
    all {
      s.detached.contains(request),
      s' = { ...s, detached: s.detached.exclude(Set(request)),
        native: if (acknowledged) nextNative else s.native,
        receipt: if (acknowledged) { request: request, before: s.native, after: nextNative }
          else s.receipt }
    }
  }

  action reply(request: int): bool = any {
    cleanupReply(request, true), cleanupReply(request, false),
    detachedReply(request, true), detachedReply(request, false)
  }

  action idle = s' = s
  action step = any {
    reopen, queueMethod, admitMethod, rejectAdmission, nativeReply, nativeEnds,
    beginCleanup("choose"), beginCleanup("leave"), beginCleanup("abort"), dispose,
    nondet request = Requests.oneOf()
    reply(request),
    idle
  }

  val DispatchOwnsRequest = all {
    s.mounts.in(1.to(2)), s.issued.in(0.to(2)),
    Set(s.request, s.native).union(s.detached).forall(id => id.in(0.to(s.issued))),
    not(s.mounted).implies(s.request == 0 and s.cleanup == NoCleanup),
    s.phase == "native" implies s.request != 0,
    not(s.detached.contains(s.request))
  }

  val CancellationKeepsItsFence = all {
    (s.cleanup.state != "none").implies(
      s.mounted and s.cleanup.request != 0 and s.cleanup.request == s.request),
    (s.phase == "queued" and s.request != 0).implies(
      s.cleanup.state == "waiting" and s.cleanup.intent == "dispatch"),
    s.cleanup.state == "failed" implies s.phase == "methods"
  }

  val ScopedReceiptPreservesForeignAttempt =
    if (s.receipt.request == 0) s.receipt == NoReceipt
    else s.receipt.after ==
      (if (s.receipt.before == s.receipt.request) 0 else s.receipt.before)

  def waiting(request: int): bool =
    (s.cleanup.request == request and s.cleanup.state == "waiting") or
      s.detached.contains(request)

  def noLongerWaiting(request: int): bool = not(waiting(request))

  temporal EveryCancellationReturns = Requests.forall(id => always(
    (waiting(id)).implies(eventually(noLongerWaiting(id)))))

  temporal FairCancellationReplies = Requests.forall(id => reply(id).weakFair(s))
    .implies(EveryCancellationReturns)

  run failedRetirementIsRetriedBeforeDispatchTest = init
    .then(queueMethod).then(admitMethod).then(beginCleanup("choose"))
    .then(cleanupReply(1, false)).then(queueMethod)
    .expect(s.issued == 1 and s.request == 1 and s.native == 1)
    .then(cleanupReply(1, true)).then(admitMethod)
    .expect(s.issued == 2 and s.request == 2 and s.native == 2)

  run lateCancelDoesNotClearNewRequestTest = init
    .then(queueMethod).then(admitMethod).then(dispose).then(nativeEnds)
    .then(reopen).then(queueMethod).then(admitMethod).then(detachedReply(1, true))
    .expect(s.native == 2 and s.request == 2 and ScopedReceiptPreservesForeignAttempt)

  run queuedWorkOwnsNoNativeAttemptTest = init.then(queueMethod).then(dispose)
    .expect(s.issued == 0 and s.detached == Set())
}

// A native attempt ID belongs to a code step, distinct from the renderer
// request ID that correlates direct and retained replies.
module NativeSignInControllerOutcome {
  pure val Request = 1
  pure val Attempt = 11
  pure val ForeignAttempt = 12
  pure val Credential = 21
  pure val Echoes = Set(0, Request, 2)
  pure val Operations = Set("email", "google", "verify-code", "verify-mfa")
  pure val NoOutcome = { source: "none", echo: 0, request: 0, attempt: 0, credential: 0 }

  type Outcome = { source: str, echo: int, request: int, attempt: int, credential: int }
  type State = { request: int, step: str, operation: str, attempt: int,
    sentAttempt: int, accepted: Outcome, retries: int }
  var s: State

  action init = s' = { request: 0, step: "methods", operation: "none",
    attempt: 0, sentAttempt: 0, accepted: NoOutcome, retries: 0 }

  action start(method: str): bool = all {
    s.request == 0, s.step == "methods",
    s' = { ...s, request: Request, operation: method }
  }

  action verify = all {
    s.operation == "none", Set("code", "mfa").contains(s.step),
    s' = { ...s, operation: if (s.step == "code") "verify-code" else "verify-mfa",
      sentAttempt: s.attempt }
  }

  pure def authenticated(x: State, source: str, echo: int): State = {
    ...x, step: "activating", operation: "none",
    accepted: { source: source, echo: echo, request: x.request,
      attempt: Attempt, credential: Credential }
  }

  pure def possibleReply(operation: str, result: str): bool =
    if (result == "code") operation == "email"
    else if (result == "mfa") Set("google", "verify-code").contains(operation)
    else if (result == "auth") operation != "email"
    else true

  action directReply(operation: str, result: str, echo: int): bool = {
    val active = s.operation == operation and s.step != "retired"
    val matching = echo == 0 or echo == s.request
    all {
      possibleReply(operation, result),
      (Set("code", "retry-error", "spent").contains(result)).implies(echo == 0),
      s' = if (not(active)) s
        else if ((result != "code" and not(matching)) or result == "spent")
          { ...s, step: "methods", operation: "none", attempt: 0 }
        else if (result == "code" or result == "mfa")
          { ...s, step: result, operation: "none", attempt: Attempt }
        else if (result == "auth") authenticated(s, "direct", echo)
        else { ...s, operation: "none" }
    }
  }

  def acceptsReturn(echo: int): bool = all {
    s.request != 0, s.request == echo, s.accepted == NoOutcome, s.step != "retired"
  }

  action retainedAuth(echo: int): bool =
    s' = if (acceptsReturn(echo)) authenticated(s, "retained", echo) else s

  // This case treats the checked native resume as one completion. A successful
  // resume retires the pending renderer callback and keeps the native attempt.
  action retainedMfa(echo: int, attempt: int, live: bool): bool =
    s' = if (acceptsReturn(echo) and attempt == Attempt and live)
      { ...s, step: "mfa", operation: "none", attempt: attempt }
      else s

  action activationReply(success: bool): bool = all {
    s.step == "activating",
    s' = { ...s, step: if (success) "complete" else "activation-failed" }
  }

  action retryActivation = all {
    s.step == "activation-failed", s.retries == 0,
    s' = { ...s, step: "activating", retries: 1 }
  }

  action dispose = all {
    s.step != "complete", s.step != "retired",
    s' = { ...s, step: "retired", operation: "none" }
  }

  action finishActivation = any { activationReply(true), activationReply(false) }

  action idle = s' = s
  action step = any {
    start("email"), start("google"), verify, finishActivation, retryActivation, dispose,
    nondet operation = Operations.oneOf()
    nondet echo = Echoes.oneOf()
    nondet result = Set("code", "mfa", "auth", "retry-error", "spent").oneOf()
    directReply(operation, result, echo),
    nondet echo = Echoes.oneOf()
    any {
      retainedAuth(echo),
      retainedMfa(echo, Attempt, true),
      retainedMfa(echo, Attempt, false),
      retainedMfa(echo, ForeignAttempt, true)
    },
    idle
  }

  val AuthenticationUsesDispatchedRequest = all {
    s.request.in(Set(0, Request)),
    (s.accepted != NoOutcome).implies(
      s.request == Request and s.accepted.request == Request and
      s.accepted.attempt == Attempt and s.accepted.credential == Credential),
    (s.accepted.source == "retained").implies(s.accepted.echo == Request),
    (s.accepted.source == "direct").implies(s.accepted.echo.in(Set(0, Request)))
  }

  val VerificationUsesDisplayedAttempt = all {
    (Set("code", "mfa").contains(s.step)).implies(s.attempt == Attempt),
    (Set("verify-code", "verify-mfa").contains(s.operation)).implies(
      s.sentAttempt == s.attempt and s.sentAttempt == Attempt),
    (s.operation == "verify-code").implies(s.step == "code"),
    (s.operation == "verify-mfa").implies(s.step == "mfa")
  }

  val ActivationOwnsStoredOutcome = all {
    (Set("activating", "activation-failed", "complete").contains(s.step)).implies(
      s.accepted != NoOutcome and s.operation == "none"),
    (s.retries > 0).implies(s.accepted != NoOutcome),
    s.retries.in(0.to(1))
  }

  temporal FairActivationReply = (finishActivation.weakFair(s)).implies(
    always((s.step == "activating").implies(eventually(s.step != "activating"))))

  run ignoresUnownedRetainedCompletionTest = init
    .then(retainedAuth(Request)).expect(s.accepted == NoOutcome)
    .then(start("google")).then(retainedAuth(0)).then(retainedAuth(2))
    .expect(s.accepted == NoOutcome)
    .then(retainedAuth(Request)).expect(s.accepted.source == "retained")
    .then(directReply("google", "auth", Request)).expect(s.accepted.source == "retained")

  run acceptsDirectLegacyAndRetriesStoredOutcomeTest = init
    .then(start("google")).then(directReply("google", "auth", 0))
    .then(activationReply(false)).then(retryActivation).then(activationReply(true))
    .expect(s.step == "complete" and s.accepted.echo == 0 and s.retries == 1)

  run retainedMfaKeepsNativeAttemptTest = init
    .then(start("google")).then(retainedMfa(Request, ForeignAttempt, true))
    .expect(s.operation == "google")
    .then(retainedMfa(Request, Attempt, true)).then(verify)
    .then(directReply("google", "auth", Request))
    .expect(s.operation == "verify-mfa" and s.sentAttempt == Attempt)
    .then(directReply("verify-mfa", "auth", Request))
    .expect(s.step == "activating" and VerificationUsesDisplayedAttempt)
}

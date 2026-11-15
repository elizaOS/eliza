// OAuthIntentsRepository and ApprovalRequestsRepository commit a row change
// and its lifecycle event in one transaction. Public proof verification and
// callback delivery remain separate protocols, outside this SQL model.
module AuthorizationIntentCommit {
  const Approval: bool
  pure val Callers = Set(1, 2)
  pure val Success = if (Approval) "approved" else "bound"
  pure val Terminal = Set(Success, "denied", "canceled", "expired")
  pure val Targets = Terminal.union(if (Approval) Set("delivered") else Set())
  pure val Deadline = 2
  type Attempt = { phase: str, target: str, tenant: int, startedAt: int, signature: bool }
  type State = {
    status: str,
    clock: int,
    events: List[str],
    delivered: bool,
    signature: bool,
    terminal: str,
    decidedAt: int,
    cancelTenant: int,
    attempts: int -> Attempt
  }
  var s: State
  action init = s' = {
    status: "absent", clock: 0, events: List(), delivered: false,
    signature: false, terminal: "none", decidedAt: -1, cancelTenant: 0,
    attempts: Callers.mapBy(_ => {phase: "new", target: "denied", tenant: 1, startedAt: 0, signature: false})
  }
  action create = all {
    s.status == "absent",
    s' = {...s, status: "pending", events: List("created")}
  }
  // Failure to write the creation event rolls back the inserted intent.
  action createFails = all { s.status == "absent", s' = s }
  action tick = all { s.clock < 3, s' = {...s, clock: s.clock + 1} }
  val Open = s.status == "pending" or s.status == "delivered"
  action prepare(caller: int, target: str, tenant: int, signature: bool): bool = all {
    s.status != "absent", s.attempts.get(caller).phase == "new", Targets.contains(target),
    not(signature) or target == "approved",
    s' = {...s, attempts: s.attempts.set(caller,
      {phase: "waiting", target: target, tenant: tenant, startedAt: s.clock, signature: signature})}
  }
  def Admitted(caller: int): bool = {
    val request = s.attempts.get(caller)
    request.phase == "waiting" and
      (if (request.target == "expired") Open and request.startedAt >= Deadline
       else Open and s.clock < Deadline and
         (request.target != "delivered" or (Approval and s.status == "pending")) and
         (request.target != "canceled" or request.tenant == 1))
  }
  // Decisions use database clock_timestamp(). Only the expiry sweeper uses
  // the caller's captured cutoff. An old service read grants no write authority.
  action commit(caller: int): bool = {
    val request = s.attempts.get(caller)
    val done = s.attempts.set(caller, {...request, phase: "done"})
    all {
      request.phase == "waiting",
      s' = if (Admitted(caller)) {
        ...s, status: request.target, events: s.events.append(request.target),
        delivered: s.delivered or request.target == "delivered",
        signature: s.signature or request.signature,
        terminal: if (Terminal.contains(request.target)) request.target else s.terminal,
        decidedAt: if (Terminal.contains(request.target)) s.clock else s.decidedAt,
        cancelTenant: if (request.target == "canceled") request.tenant else s.cancelTenant,
        attempts: done
      } else {...s, attempts: done}
    }
  }
  // A failed decision/event statement rolls back signature fields as well.
  action storageFailure(caller: int): bool = all {
    s.attempts.get(caller).phase == "waiting",
    s' = {...s, attempts: s.attempts.set(caller, {...s.attempts.get(caller), phase: "done"})}
  }
  action step = any {
    create, createFails, tick,
    {
      nondet caller = Callers.oneOf()
      nondet target = Targets.oneOf()
      nondet tenant = Set(1, 2).oneOf()
      nondet signature = Set(false, target == "approved").oneOf()
      prepare(caller, target, tenant, signature)
    },
    { nondet caller = Callers.oneOf(); commit(caller) },
    { nondet caller = Callers.oneOf(); storageFailure(caller) },
    s' = s
  }
  val TypeOK = and {
    Terminal.union(Set("absent", "pending", "delivered")).contains(s.status),
    Set(0, 1, 2, 3).contains(s.clock),
    Callers.forall(c => Set("new", "waiting", "done").contains(s.attempts.get(c).phase)),
    Approval or not(s.delivered)
  }
  val terminalStable = s.terminal == "none" or s.status == s.terminal
  val exactReceipt = s.events == (
    if (s.status == "absent") List()
    else {
      val prefix = if (s.delivered) List("created", "delivered") else List("created")
      if (Terminal.contains(s.status)) prefix.append(s.status) else prefix
    })
  val acceptedWithinLifetime = not(Set("approved", "bound").contains(s.status)) or
    (s.decidedAt >= 0 and s.decidedAt < Deadline)
  val exactCancellationTenant = s.status != "canceled" or s.cancelTenant == 1
  val signatureWithReceipt = s.signature implies s.status == "approved"
  val safety = TypeOK and terminalStable and exactReceipt and acceptedWithinLifetime and
    exactCancellationTenant and signatureWithReceipt
  val Idle = Callers.forall(c => s.attempts.get(c).phase != "waiting")
  temporal operationsSettle = Callers.forall(c => commit(c).weakFair(s)) implies eventually(always(Idle))

  run acceptedDecisionTest = init.then(create)
    .then(prepare(1, Success, 1, Approval)).then(commit(1))
    .expect(safety and s.status == Success and s.events == List("created", Success))
  run competingDecisionsTest = init.then(create)
    .then(prepare(1, Success, 1, Approval)).then(prepare(2, "canceled", 1, false))
    .then(commit(2)).then(commit(1))
    .expect(safety and s.status == "canceled" and s.events == List("created", "canceled"))
  run expirationBoundaryTest = init.then(create).then(prepare(1, Success, 1, Approval))
    .then(tick).then(tick).then(commit(1))
    .then(prepare(2, "expired", 1, false)).then(commit(2))
    .expect(safety and s.status == "expired")
  run foreignCancellationTest = init.then(create)
    .then(prepare(1, "canceled", 2, false)).then(commit(1))
    .expect(safety and s.status == "pending" and s.events == List("created"))
  run failedTransactionTest = init.then(create)
    .then(prepare(1, Success, 1, Approval)).then(storageFailure(1))
    .expect(safety and s.status == "pending" and not(s.signature))
  run failedCreationTest = init.then(createFails)
    .expect(safety and s.status == "absent" and s.events == List())
  run retryAfterRollbackTest = init.then(create)
    .then(prepare(1, Success, 1, Approval)).then(storageFailure(1))
    .then(prepare(2, Success, 1, Approval)).then(commit(2))
    .expect(safety and s.status == Success and s.events == List("created", Success))
  run expiryReceiptIsIdempotentTest = init.then(create).then(tick).then(tick)
    .then(prepare(1, "expired", 1, false)).then(commit(1))
    .then(prepare(2, "expired", 1, false)).then(commit(2))
    .expect(safety and s.events == List("created", "expired"))
}
module authorization_intents { import AuthorizationIntentCommit(Approval = false).* }
module approval_requests {
  import AuthorizationIntentCommit(Approval = true).*
  run competingDeliveryHasOneReceiptTest = init.then(create)
    .then(prepare(1, "delivered", 1, false)).then(prepare(2, "delivered", 1, false))
    .then(commit(1)).then(commit(2))
    .expect(safety and s.status == "delivered" and s.events == List("created", "delivered"))
  run deliveryCannotReplaceDecisionTest = init.then(create)
    .then(prepare(1, "delivered", 1, false)).then(prepare(2, "approved", 1, true))
    .then(commit(2)).then(commit(1))
    .expect(safety and s.status == "approved" and s.events == List("created", "approved"))
}

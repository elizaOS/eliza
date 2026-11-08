// Bounded contract for OAuth intents and signed approval requests.
// Two callers may prepare competing decisions; only the durable commit owns
// the decision and its receipt. Cryptographic validation is an environment
// assumption represented by proofValid, not a cryptographic proof.
// Intended contract only: implementation refinement remains pending private
// review of the repositories and services below.
// Sources: shared/src/db/repositories/{oauth-intents,approval-requests}.ts and
// shared/src/lib/services/{oauth-intents,approval-requests}.ts (under cloud/).
module authorization_intents {
  type Machine = {
    phase: str,
    approval: bool,
    clock: int,
    expiresAt: int,
    decision: str,
    receipts: int,
    acceptedAt: int,
    acceptedTenant: int,
    acceptedProofValid: bool,
  }
  type Attempt = {
    waiting: bool,
    observed: str,
    requested: str,
    tenant: int,
    proofValid: bool,
  }

  pure val callers = Set("first", "second")
  pure val terminal = Set("accepted", "denied", "canceled", "expired")
  pure val idle = {
    waiting: false,
    observed: "pending",
    requested: "accepted",
    tenant: 1,
    proofValid: false,
  }

  var machine: Machine
  var attempts: str -> Attempt

  action init = {
    nondet approval = Set(false, true).oneOf()
    all {
      machine' = {
        phase: "pending",
        approval: approval,
        clock: 0,
        expiresAt: 2,
        decision: "none",
        receipts: 0,
        acceptedAt: -1,
        acceptedTenant: 0,
        acceptedProofValid: false,
      },
      attempts' = Map("first" -> idle, "second" -> idle),
    }
  }

  val open = machine.phase == "pending" or machine.phase == "delivered"
  val live = machine.clock < machine.expiresAt

  action prepare(caller, requested, tenant, proofValid) = all {
    open,
    not(attempts.get(caller).waiting),
    attempts' = attempts.set(caller, {
      waiting: true,
      observed: machine.phase,
      requested: requested,
      tenant: tenant,
      proofValid: proofValid,
    }),
    machine' = machine,
  }

  // Delivery is advisory progress, never a replacement for a terminal decision.
  action deliver = all {
    machine.approval,
    machine.phase == "pending",
    live,
    machine' = machine.with("phase", "delivered"),
    attempts' = attempts,
  }

  def admissible(caller) = all {
    attempts.get(caller).waiting,
    open,
    live,
    attempts.get(caller).tenant == 1,
    attempts.get(caller).requested != "accepted" or attempts.get(caller).proofValid,
  }

  action commit(caller) = {
    val request = attempts.get(caller)
    all {
      admissible(caller),
      machine' = machine
        .with("phase", request.requested)
        .with("decision", request.requested)
        .with("receipts", machine.receipts + 1)
        .with("acceptedAt", if (request.requested == "accepted") machine.clock else -1)
        .with("acceptedTenant", if (request.requested == "accepted") request.tenant else 0)
        .with("acceptedProofValid", request.requested == "accepted" and request.proofValid),
      attempts' = attempts.set(caller, idle),
    }
  }

  // A failed persistence attempt rolls back both state and receipt.
  action storageFailure(caller) = all {
    attempts.get(caller).waiting,
    machine' = machine,
    attempts' = attempts.set(caller, idle),
  }

  action reject(caller) = all {
    attempts.get(caller).waiting,
    not(admissible(caller)),
    machine' = machine,
    attempts' = attempts.set(caller, idle),
  }

  action expire = all {
    open,
    not(live),
    machine' = machine
      .with("phase", "expired")
      .with("decision", "expired")
      .with("receipts", machine.receipts + 1),
    attempts' = attempts,
  }

  action tick = all {
    machine.clock < 3,
    machine' = machine.with("clock", machine.clock + 1),
    attempts' = attempts,
  }

  action step = {
    nondet caller = callers.oneOf()
    nondet requested = Set("accepted", "denied", "canceled").oneOf()
    nondet tenant = Set(1, 2).oneOf()
    nondet proofValid = Set(false, true).oneOf()
    any {
      prepare(caller, requested, tenant, proofValid),
      deliver,
      commit(caller),
      storageFailure(caller),
      reject(caller),
      expire,
      tick,
      all { machine' = machine, attempts' = attempts },
    }
  }

  val terminalStable = machine.decision == "none" or machine.phase == machine.decision
  val exactReceipt = if (terminal.contains(machine.phase)) machine.receipts == 1 else machine.receipts == 0
  val acceptedWithinLifetime = machine.phase != "accepted" or all {
    machine.acceptedAt >= 0,
    machine.acceptedAt < machine.expiresAt,
    machine.acceptedTenant == 1,
    machine.acceptedProofValid,
  }
  val safety = terminalStable and exactReceipt and acceptedWithinLifetime

  run acceptedDecisionTest = init
    .then(prepare("first", "accepted", 1, true))
    .then(commit("first"))
    .expect(safety and machine.phase == "accepted" and machine.receipts == 1)

  run competingDecisionsTest = init
    .then(prepare("first", "accepted", 1, true))
    .then(prepare("second", "canceled", 1, false))
    .then(commit("second"))
    .then(reject("first"))
    .expect(safety and machine.phase == "canceled" and machine.receipts == 1)

  run expirationBoundaryTest = init
    .then(prepare("first", "accepted", 1, true))
    .then(tick).then(tick)
    .then(reject("first")).then(expire)
    .expect(safety and machine.phase == "expired" and machine.acceptedAt == -1)

  run foreignTenantTest = init
    .then(prepare("first", "accepted", 2, true))
    .then(reject("first"))
    .expect(safety and machine.phase == "pending" and machine.receipts == 0)

  run invalidProofTest = init
    .then(prepare("first", "accepted", 1, false))
    .then(reject("first"))
    .expect(safety and machine.phase == "pending")

  run failedTransactionTest = init
    .then(prepare("first", "accepted", 1, true))
    .then(storageFailure("first"))
    .expect(safety and machine.phase == "pending" and machine.receipts == 0)
}

// useModel provider failover: which provider failure lets the dispatch try
// the next registration (isModelProviderFallbackError in
// security/model-failure.ts, read through utils/model-errors.ts), and how the
// dispatch loop in runtime/model-dispatch.ts walks its registrations.
module ModelProviderFailover {
  // Registrations in dispatch order: 0 = provider alpha (priority 30),
  // 1 = provider alpha (priority 20), 2 = provider beta (priority 10).
  // 3 means no registration is left.
  //
  // Outcome of one registration's handler:
  // 0 answers
  // 1 AI SDK "Cannot connect to API" with ECONNREFUSED on its cause
  // 2 AI SDK retry envelope whose lastError has Bun's ConnectionRefused on
  //   its cause
  // 3 HTTP 400 from a live endpoint
  // 4 funding authority denial whose cause is a refused connection
  // 5 processing-policy denial whose cause is a refused connection
  // 6 AbortError whose cause is a refused connection
  // 7 the caller aborts its signal, then the handler reports a refused
  //   connection
  // 8 the provider's own retry budget is exhausted
  //
  // modelType: 0 TEXT_SMALL, 1 TEXT_TO_SPEECH.
  // phase: 0 dispatching, 1 answered, 2 rejected.
  var modelType: int
  var outcome0: int
  var outcome1: int
  var outcome2: int
  var phase: int
  var pending: int
  var attempts: List[int]
  var spent: Set[int]
  var answeredBy: int
  var rejectedWith: int

  pure val Registrations = Set(0, 1, 2)
  pure val Outcomes = Set(0, 1, 2, 3, 4, 5, 6, 7, 8)
  pure val NONE = 3
  pure val ANSWER = 0
  pure val BUDGET_EXHAUSTED = 8

  pure def providerOf(registration: int): int =
    if (registration <= 1) 0 else 1

  // The classifier: the funding, processing-policy and TEXT_TO_SPEECH gates
  // run first, then cancellation, then the exhausted retry budget and the
  // socket codes found anywhere on the cause and retry envelopes.
  pure def failsOver(outcome: int, model: int): bool =
    model == 0 and Set(1, 2, BUDGET_EXHAUSTED).contains(outcome)

  // The next registration after `after` whose provider still has budget.
  pure def nextEligible(after: int, exhausted: Set[int]): int =
    if (after + 1 <= 2 and not(exhausted.contains(providerOf(after + 1))))
      after + 1
    else if (after + 2 <= 2 and not(exhausted.contains(providerOf(after + 2))))
      after + 2
    else NONE

  def outcomeOf(registration: int): int =
    if (registration == 0) outcome0
    else if (registration == 1) outcome1
    else outcome2

  action init = {
    nondet chosenModel = Set(0, 1).oneOf()
    nondet chosen0 = Outcomes.oneOf()
    nondet chosen1 = Outcomes.oneOf()
    nondet chosen2 = Outcomes.oneOf()
    all {
      modelType' = chosenModel,
      outcome0' = chosen0,
      outcome1' = chosen1,
      outcome2' = chosen2,
      phase' = 0,
      pending' = 0,
      attempts' = List(),
      spent' = Set(),
      answeredBy' = -1,
      rejectedWith' = -1,
    }
  }

  // One handler call for the next registration and the dispatch decision.
  action attempt = {
    val registration = pending
    val outcome = outcomeOf(registration)
    val exhausted =
      if (outcome == BUDGET_EXHAUSTED) spent.union(Set(providerOf(registration)))
      else spent
    val following = nextEligible(registration, exhausted)
    all {
      phase == 0,
      pending != NONE,
      modelType' = modelType,
      outcome0' = outcome0,
      outcome1' = outcome1,
      outcome2' = outcome2,
      attempts' = attempts.append(registration),
      spent' = exhausted,
      if (outcome == ANSWER) all {
        phase' = 1, pending' = pending, answeredBy' = registration,
        rejectedWith' = -1,
      } else if (failsOver(outcome, modelType) and following != NONE) all {
        phase' = 0, pending' = following, answeredBy' = -1, rejectedWith' = -1,
      } else all {
        phase' = 2, pending' = pending, answeredBy' = -1, rejectedWith' = outcome,
      },
    }
  }

  action settled = all {
    phase != 0,
    modelType' = modelType,
    outcome0' = outcome0,
    outcome1' = outcome1,
    outcome2' = outcome2,
    phase' = phase,
    pending' = pending,
    attempts' = attempts,
    spent' = spent,
    answeredBy' = answeredBy,
    rejectedWith' = rejectedWith,
  }

  action step = any { attempt, settled }

  val TypeOK = all {
    Set(0, 1).contains(modelType),
    Outcomes.contains(outcome0),
    Outcomes.contains(outcome1),
    Outcomes.contains(outcome2),
    Set(0, 1, 2).contains(phase),
    Registrations.contains(pending),
    attempts.length() <= 3,
    spent.subseteq(Set(0, 1)),
  }

  // Bounded retries: registrations run in dispatch order, each at most once.
  val EachRegistrationOnce =
    attempts.indices().forall(i => attempts.indices().forall(j =>
      i >= j or attempts[i] < attempts[j]))

  // Bounded retries: after a provider exhausts its own retry budget, no other
  // registration of that provider runs in this dispatch.
  val ExhaustedProviderSkipped =
    attempts.indices().forall(i => attempts.indices().forall(j =>
      i >= j or outcomeOf(attempts[i]) != BUDGET_EXHAUSTED or
        providerOf(attempts[j]) != providerOf(attempts[i])))

  // Terminal precedence: funding, policy, cancellation and a request error
  // end the dispatch even when their cause is a refused connection, and
  // TEXT_TO_SPEECH never fails over.
  val TerminalOutcomeEndsDispatch =
    attempts.indices().forall(i =>
      i == attempts.length() - 1 or
        (modelType == 0 and not(Set(3, 4, 5, 6, 7).contains(outcomeOf(attempts[i])))))

  // Nested causes and provider exhaustion: a TEXT_SMALL refused connection,
  // on the SDK error's cause or inside a retry envelope, or an exhausted
  // provider budget reaches the next registration whose provider has budget;
  // the dispatch rejects with it only when no such registration is left.
  val RefusedConnectionFailsOver =
    phase == 0 or attempts.indices().forall(i =>
      i != attempts.length() - 1 or modelType != 0 or
        not(Set(1, 2, BUDGET_EXHAUSTED).contains(outcomeOf(attempts[i]))) or
        nextEligible(attempts[i], spent) == NONE)

  // The rejection is the last attempted registration's failure.
  val RejectsWithLastFailure =
    phase != 2 or (attempts.length() > 0 and
      rejectedWith == outcomeOf(attempts[attempts.length() - 1]) and
      rejectedWith != ANSWER)

  val AnswerIsLastAttempt =
    phase != 1 or (attempts.length() > 0 and
      answeredBy == attempts[attempts.length() - 1] and
      outcomeOf(answeredBy) == ANSWER)
}

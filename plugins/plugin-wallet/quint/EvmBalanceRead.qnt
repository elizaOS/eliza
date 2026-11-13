// analytics/evm-balances.ts: direct RPC reads of zero to two known tokens, through at
// most two endpoints. RPC and decimal errors are explicit failed observations.
module EvmBalanceRead {
  pure val Tokens = Set(0, 1)
  type State = {
    tokens: Set[int], endpoint: int, phase: str, settled: Set[int], failed: Set[int],
    zero: Set[int], positive: Set[int], decimalsRead: Set[int],
    validDecimals: Set[int], published: Set[int], response: str
  }
  var s: State
  pure def initial(endpoint: int, tokens: Set[int]): State = {
    tokens: tokens, endpoint: endpoint, phase: "native", settled: Set(), failed: Set(),
    zero: Set(), positive: Set(), decimalsRead: Set(), validDecimals: Set(),
    published: Set(), response: "none"
  }
  pure def failAttempt(state: State): State =
    if (state.endpoint == 0) initial(1, state.tokens)
    else { ...state, phase: "done", response: "error", published: Set() }
  action init = {
    nondet tokens = Set(Set(), Set(0), Tokens).oneOf()
    s' = initial(0, tokens)
  }
  action initTwoTokens = s' = initial(0, Tokens)
  action initEmpty = s' = initial(0, Set())
  action Native(ok: bool): bool = all {
    s.phase == "native",
    if (ok) s' = { ...s, phase: "tokens" }
    else s' = failAttempt(s)
  }
  action ReadToken(token: int, result: str): bool = all {
    s.phase == "tokens", s.tokens.contains(token), not(s.settled.contains(token)),
    if (result == "zero") s' = {
      ...s, settled: s.settled.union(Set(token)), zero: s.zero.union(Set(token))
    } else if (result == "positive") s' = {
      ...s, settled: s.settled.union(Set(token)), positive: s.positive.union(Set(token)),
      decimalsRead: s.decimalsRead.union(Set(token)), validDecimals: s.validDecimals.union(Set(token))
    } else s' = {
      ...s, settled: s.settled.union(Set(token)), failed: s.failed.union(Set(token)),
      decimalsRead: if (result == "badDecimals") s.decimalsRead.union(Set(token)) else s.decimalsRead
    }
  }
  action Decide = all {
    s.phase == "tokens", s.settled == s.tokens,
    if (s.failed.size() == 0) s' = {
      ...s, phase: "done", response: "success", published: s.positive
    } else s' = failAttempt(s)
  }
  action progress = any {
    { nondet ok = Set(false, true).oneOf(); Native(ok) },
    {
      nondet token = s.tokens.oneOf()
      nondet result = Set("zero", "positive", "badBalance", "badDecimals", "rpcError").oneOf()
      ReadToken(token, result)
    },
    Decide
  }
  action step = any { progress, s' = s }
  val BoundedEndpoints = 0 <= s.endpoint and s.endpoint <= 1
  val CompleteSuccess = (s.response == "success").implies(
    s.settled == s.tokens and s.failed.size() == 0 and s.published == s.positive)
  val NoGuessedDecimals = s.published.subseteq(s.validDecimals)
  val ZeroSkipsMetadata = s.zero.intersect(s.decimalsRead).size() == 0
  val ErrorHasNoHoldings = (s.response == "error").implies(s.published.size() == 0)
  val FailedReadNeverPublished = s.failed.intersect(s.published).size() == 0
  temporal EventuallyReturns = progress.weakFair(s).implies(eventually(s.phase == "done"))
  temporal DeadlockFree = always(enabled(step))
  run healthy = initTwoTokens.then(Native(true)).then(ReadToken(0, "zero"))
    .then(ReadToken(1, "positive")).then(Decide)
    .expect(s.response == "success" and s.published == Set(1))
  run partialFailureRetries = initTwoTokens.then(Native(true)).then(ReadToken(0, "positive"))
    .then(ReadToken(1, "rpcError")).then(Decide).expect(s.endpoint == 1 and s.response == "none")
    .then(Native(true)).then(ReadToken(0, "zero")).then(ReadToken(1, "zero")).then(Decide)
    .expect(s.response == "success" and s.published.size() == 0)
  run emptyTokenList = initEmpty.then(Native(true)).then(Decide)
    .expect(s.response == "success" and s.published.size() == 0)
  run exhaustedReturnsError = initTwoTokens.then(Native(false)).then(Native(false))
    .expect(s.response == "error" and s.published.size() == 0)
}

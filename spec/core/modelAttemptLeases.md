# Host model attempt allowances

The host issues a session allowance and unforgeable per-turn leases. Each qualified request atomically debits its conservative reservation and consumes an attempt, including failed transport attempts. Sources include [streaming-context.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/streaming-context.ts) and [prepared-model-request.ts](https://github.com/elizaOS/eliza/blob/72fed7e4069ecd35d61d886ab6eec5c02c137517/packages/core/src/runtime/prepared-model-request.ts). The arithmetic helpers compare affordability before multiplying values that can exceed the safe integer range.

## Story: Issue a turn-scoped model allowance

As a host I authorize bounded model attempts with a concrete provider tariff, expiry and output cap.

### Only host-issued leases bind an existing allowance to a turn

Allowance closure and session abort apply to all its leases. A turn abort closes only its own lease. Absolute wall-clock observations may move backward, as `Date.now()` can. Expiry alone does not close an allowance: an expired but unclosed allowance can become time-eligible after a rewind. The `expiryObserved` flag is a verification history monitor, not additional runtime state.

```quint
type Tariff = {provider: str, model: str, route: str, inputRate: int, outputRate: int, inputBound: int}
type AllowanceInput = {budget: int, maxAttempts: int, maxOutput: int, expiresAt: int, tariffs: List[Tariff]}
type AttemptReservationInput = {messageId: str, provider: str, model: str, route: str, byteCount: int, bytes: str, outputTokens: int, currentTurn: bool}
type Allowance = {id: int, remaining: int, attemptsRemaining: int, maxOutput: int, expiresAt: int, closed: bool, expiryObserved: bool, tariffs: List[Tariff]}
type AttemptLease = {id: int, allowance: int, messageId: str, ended: bool}
type Reservation = {lease: int, amount: int, provider: str, model: str, route: str, bytes: str}
type ModelLeases = {now: int, allowances: List[Allowance], leases: List[AttemptLease], reservations: List[Reservation]}
pure val initial: ModelLeases = {now: 0, allowances: List(), leases: List(), reservations: List()}
pure val allowanceIdValues = Set(1, 2)
pure val leaseIdValues = Set(1, 2, 3)
pure val allowanceInputValues = Set(
  {budget: 100, maxAttempts: 3, maxOutput: 10, expiresAt: 100, tariffs: List({provider: "alpha", model: "small", route: "text", inputRate: 1, outputRate: 2, inputBound: 20})},
  {budget: 1, maxAttempts: 1, maxOutput: 1, expiresAt: 1, tariffs: List({provider: "alpha", model: "small", route: "text", inputRate: 1, outputRate: 2, inputBound: 20})},
  {budget: 10, maxAttempts: 2, maxOutput: 10, expiresAt: 10, tariffs: List({provider: "beta", model: "large", route: "text", inputRate: 100, outputRate: 200, inputBound: 100})},
  {budget: 0, maxAttempts: 1, maxOutput: 1, expiresAt: 10, tariffs: List()})
pure val tValues = Set({provider: "alpha", model: "small", route: "text", inputRate: 1, outputRate: 2, inputBound: 20}, {provider: "beta", model: "large", route: "text", inputRate: 100, outputRate: 200, inputBound: 100})
pure val messageIdValues = Set("turn-a", "turn-b")
pure val providerValues = Set("alpha", "beta", "missing")
pure val modelValues = Set("small", "large")
pure val routeValues = Set("text", "missing")
pure val outputTokensValues = Set(0, 1, 10)
pure val reservationInputValues = Set(
  {messageId: "turn-a", provider: "alpha", model: "small", route: "text", byteCount: 10, bytes: "complete request", outputTokens: 1, currentTurn: true},
  {messageId: "turn-b", provider: "alpha", model: "small", route: "text", byteCount: 10, bytes: "complete request", outputTokens: 10, currentTurn: true},
  {messageId: "turn-a", provider: "beta", model: "large", route: "text", byteCount: 10, bytes: "complete request", outputTokens: 1, currentTurn: true},
  {messageId: "turn-a", provider: "alpha", model: "small", route: "missing", byteCount: 10, bytes: "complete request", outputTokens: 1, currentTurn: true},
  {messageId: "turn-a", provider: "alpha", model: "small", route: "text", byteCount: 200, bytes: "complete request", outputTokens: 1, currentTurn: true},
  {messageId: "turn-a", provider: "alpha", model: "small", route: "text", byteCount: 10, bytes: "complete request", outputTokens: 0, currentTurn: true},
  {messageId: "turn-a", provider: "alpha", model: "small", route: "text", byteCount: 10, bytes: "complete request", outputTokens: 1, currentTurn: false})
pure val nowValues = Set(-1, 0, 1, 10, 100, 101)
pure val noAllowance: Allowance = {id: 0, remaining: 0, attemptsRemaining: 0, maxOutput: 0, expiresAt: 0, closed: true, expiryObserved: false, tariffs: List()}
pure val noLease: AttemptLease = {id: 0, allowance: 0, messageId: "", ended: true}
pure val noTariff: Tariff = {provider: "", model: "", route: "", inputRate: 0, outputRate: 0, inputBound: 0}
pure def allowance(s: ModelLeases, allowanceId: int): Allowance = s.allowances.select(a => a.id == allowanceId).nthOr(0, noAllowance)
pure def issuedLease(s: ModelLeases, leaseId: int): AttemptLease = s.leases.select(l => l.id == leaseId).nthOr(0, noLease)
pure def canCreateAllowance(s: ModelLeases, allowanceId: int, allowanceInput: AllowanceInput): bool = allowanceId > 0 and not(s.allowances.some(a => a.id == allowanceId)) and allowanceInput.budget > 0 and allowanceInput.maxAttempts > 0 and allowanceInput.maxOutput > 0 and allowanceInput.expiresAt > 0 and allowanceInput.tariffs.length() > 0 and allowanceInput.tariffs.every(t => t.provider != "" and t.model != "" and t.route != "" and t.inputRate > 0 and t.outputRate > 0 and t.inputBound > 0)
pure def createAllowance(s: ModelLeases, allowanceId: int, allowanceInput: AllowanceInput): ModelLeases = { ...s, allowances: s.allowances.append({id: allowanceId, remaining: allowanceInput.budget, attemptsRemaining: allowanceInput.maxAttempts, maxOutput: allowanceInput.maxOutput, expiresAt: allowanceInput.expiresAt, closed: false, expiryObserved: s.now >= allowanceInput.expiresAt, tariffs: allowanceInput.tariffs}) }
pure def canOpenTurnLease(s: ModelLeases, allowanceId: int, leaseId: int, messageId: str): bool = allowance(s, allowanceId).id != 0 and not(allowance(s, allowanceId).closed) and s.now < allowance(s, allowanceId).expiresAt and leaseId > 0 and not(s.leases.some(l => l.id == leaseId)) and messageId != ""
pure def openTurnLease(s: ModelLeases, allowanceId: int, leaseId: int, messageId: str): ModelLeases = { ...s, leases: s.leases.append({id: leaseId, allowance: allowanceId, messageId: messageId, ended: false}) }
pure def canCloseTurnLease(s: ModelLeases, leaseId: int): bool = issuedLease(s, leaseId).id != 0
pure def closeTurnLease(s: ModelLeases, leaseId: int): ModelLeases = { ...s, leases: s.leases.listMap(l => if (l.id == leaseId) { ...l, ended: true } else l) }
pure def canCloseAllowance(s: ModelLeases, allowanceId: int): bool = allowance(s, allowanceId).id != 0
pure def closeAllowance(s: ModelLeases, allowanceId: int): ModelLeases = { ...s, allowances: s.allowances.listMap(a => if (a.id == allowanceId) { ...a, closed: true } else a) }
pure def leaseContextValid(s: ModelLeases, leaseId: int, messageId: str): bool = issuedLease(s, leaseId).id != 0 and issuedLease(s, leaseId).messageId == messageId
pure def setAllowanceClock(s: ModelLeases, now: int): ModelLeases = { ...s, now: now, allowances: s.allowances.listMap(a => { ...a, expiryObserved: a.expiryObserved or now >= a.expiresAt }) }
pure def alwaysAllowanceIdsUnique(s: ModelLeases): bool = s.allowances.every(a => a.id > 0 and s.allowances.select(other => other.id == a.id).length() == 1)
pure def alwaysLeaseHasAllowance(s: ModelLeases): bool = s.leases.every(l => l.id > 0 and allowance(s, l.allowance).id != 0 and l.messageId != "")
pure def alwaysLeasesUnique(s: ModelLeases): bool = s.leases.every(l => s.leases.select(other => other.id == l.id).length() == 1)
pure def sometimesRewindRestoresTimeEligibility(s: ModelLeases): bool = s.allowances.some(a => a.expiryObserved and not(a.closed) and s.now < a.expiresAt)
pure def sometimesIndependentTurnLeases(s: ModelLeases): bool = s.leases.some(a => s.leases.some(b => a.allowance == b.allowance and a.id != b.id and a.ended and not(b.ended)))
```

### Each qualified attempt consumes the tariff reservation atomically

Reservation receives one correlated request record with its captured route, byte observation and turn authority. Provider, model and route match the first qualified tariff. The request bytes fit its conservative input bound and an explicit output count fits the allowance cap. Funds and attempts are never refunded.

Discovered by the proof. Every retained allowance has a positive distinct identity, so a lease can resolve its captured allowance after an unrelated allowance update.

```quint
type ChargePart = {within: bool, whole: int, remainder: int}
pure val unaffordablePart: ChargePart = {within: false, whole: 0, remainder: 0}
pure def productCharge(a: int, b: int, limit: int): ChargePart = {
  val aq = a / 1000
  val ar = a % 1000
  val bq = b / 1000
  val br = b % 1000
  val second = ar * bq
  val third = (ar * br) / 1000
  if (a < 0 or b <= 0 or limit < 0) unaffordablePart
  else if (aq > limit / b) unaffordablePart
  else if (second > limit - aq * b) unaffordablePart
  else if (third > limit - aq * b - second) unaffordablePart
  else {within: true, whole: aq * b + second + third, remainder: (ar * br) % 1000}
}
pure def reservationCharge(t: Tariff, outputTokens: int, remaining: int): ChargePart = {
  val input = productCharge(t.inputBound, t.inputRate, remaining)
  val output = productCharge(outputTokens, t.outputRate, remaining - input.whole)
  val rounding = (input.remainder + output.remainder + 999) / 1000
  if (not(input.within) or not(output.within) or rounding > remaining - input.whole - output.whole) unaffordablePart
  else {within: true, whole: input.whole + output.whole + rounding, remainder: 0}
}
pure def selectedTariff(s: ModelLeases, leaseId: int, provider: str, model: str, route: str): Tariff = allowance(s, issuedLease(s, leaseId).allowance).tariffs.select(t => t.provider == provider and t.model == model and t.route == route).nthOr(0, noTariff)
pure def canReserveAttempt(s: ModelLeases, leaseId: int, reservationInput: AttemptReservationInput): bool = {
  val lease = issuedLease(s, leaseId)
  val account = allowance(s, lease.allowance)
  val tariff = selectedTariff(s, leaseId, reservationInput.provider, reservationInput.model, reservationInput.route)
  leaseContextValid(s, leaseId, reservationInput.messageId) and not(lease.ended) and not(account.closed) and s.now < account.expiresAt and reservationInput.currentTurn and tariff.provider != "" and reservationInput.byteCount >= 0 and reservationInput.byteCount <= tariff.inputBound and reservationInput.outputTokens > 0 and reservationInput.outputTokens <= account.maxOutput and account.attemptsRemaining > 0 and reservationCharge(tariff, reservationInput.outputTokens, account.remaining).within
}
pure def reserveAttempt(s: ModelLeases, leaseId: int, reservationInput: AttemptReservationInput): ModelLeases = {
  val accountId = issuedLease(s, leaseId).allowance
  val charge = reservationCharge(selectedTariff(s, leaseId, reservationInput.provider, reservationInput.model, reservationInput.route), reservationInput.outputTokens, allowance(s, accountId).remaining).whole
  { ...s, allowances: s.allowances.listMap(a => if (a.id == accountId) { ...a, remaining: a.remaining - charge, attemptsRemaining: a.attemptsRemaining - 1 } else a), reservations: s.reservations.append({lease: leaseId, amount: charge, provider: reservationInput.provider, model: reservationInput.model, route: reservationInput.route, bytes: reservationInput.bytes}) }
}
pure def alwaysAllowancesNonnegative(s: ModelLeases): bool = s.allowances.every(a => a.remaining >= 0 and a.attemptsRemaining >= 0)
pure def stepAllowanceNeverRefunded(before: ModelLeases, after: ModelLeases): bool = before.allowances.every(a => after.allowances.some(b => b.id == a.id and b.remaining <= a.remaining and b.attemptsRemaining <= a.attemptsRemaining and (not(a.closed) or b.closed)))
pure def stepClosedLeaseStaysClosed(before: ModelLeases, after: ModelLeases): bool = before.leases.every(l => after.leases.some(other => other.id == l.id and (not(l.ended) or other.ended)))
pure def lawAffordableChargeBound(t: Tariff, outputTokens: int, remaining: int): bool = reservationCharge(t, outputTokens, remaining).within implies reservationCharge(t, outputTokens, remaining).whole >= 0 and reservationCharge(t, outputTokens, remaining).whole <= remaining
pure def sometimesReservationDebited(s: ModelLeases): bool = s.reservations.length() > 0
```

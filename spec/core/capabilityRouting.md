# Capability routing

The compatibility baseline is `elizaOS/eliza@72fed7e4069ecd35d61d886ab6eec5c02c137517`. Sources are `packages/core/src/capabilities/router.ts`, `account-selection.ts`, `remote-runner.ts`, `protocol.ts` and `decoder.ts`, `packages/core/src/capability-catalog.ts`, `packages/core/src/services/runtime-capability-service.ts` and `packages/core/src/types/provider-integrations.ts`. A capability request names what it needs, not who serves it; the runtime, never the model, chooses the connected account and the runner. The authority a dispatched request consumes is [capability authority](./capabilityAuthority.md) and [capability reservations](./capabilityCoordinator.md); which implementation backs a capability is [capability strategies](./capabilityStrategies.md).

## Story: Route to a local or remote runner

> As a user, I want each capability request to run on one runner, local
> when the device can serve it and remote otherwise, with an account I
> connected and never a substitute for the one I named, and to fail with a
> reason I can act on, so that work is never done twice, under the wrong
> account or silently.

### A request runs on at most one runner, chosen once

Routing binds a request to the local runner when it is available, else to the remote runner when that is available, else to none, and the request fails as unavailable. Once bound, the runner never changes: a remote failure is not retried on the local runner behind the caller's back.

```quint
import accountValues as A from "./accountValues"
type HeldAccount = { id: str, status: A::AccountStatus, cost: int }
type Runner = NoRunner | LocalRunner | RemoteRunner
type RoutePhase = Routed | Running | Succeeded | RouteFailed
type Failure = NoFailure | CapabilityUnavailable | AccountIneligible | RemoteUnreachable | RequestFailed
type RouteRequest = { id: int, pinned: str, account: str, runner: Runner, phase: RoutePhase, failure: Failure }
type Routing = { accounts: List[HeldAccount], requests: List[RouteRequest] }
pure val initial: Routing = { accounts: List(), requests: List() }
pure val idValues = Set(1, 2, 3)
pure val noAccount: HeldAccount = { id: "", status: A::AccountRevoked, cost: 0 }
pure val noRequest: RouteRequest = { id: 0, pinned: "", account: "", runner: NoRunner, phase: RouteFailed, failure: CapabilityUnavailable }
pure def requestAt(s: Routing, id: int): RouteRequest = s.requests.select(r => r.id == id).nthOr(0, noRequest)
pure def knownRequest(s: Routing, id: int): bool = s.requests.some(r => r.id == id)
pure def eligible(s: Routing): List[HeldAccount] = s.accounts.select(a => A::connectedOnly.includes(a.status))
pure def isEligible(s: Routing, accountId: str): bool = accountId != "" and eligible(s).some(a => a.id == accountId)
pure def cheapest(accounts: List[HeldAccount]): str = accounts.foldl(noAccount, (best, a) => if (best.id == "" or a.cost < best.cost) a else best).id
pure def chosenAccount(s: Routing, pinned: str): str = if (pinned != "") (if (isEligible(s, pinned)) pinned else "") else cheapest(eligible(s))
pure def chosenRunner(localAvailable: bool, remoteAvailable: bool): Runner = if (localAvailable) LocalRunner else if (remoteAvailable) RemoteRunner else NoRunner
pure def canRoute(s: Routing, id: int, pinned: str, localAvailable: bool, remoteAvailable: bool): bool = id > 0 and not(knownRequest(s, id))
pure def route(s: Routing, id: int, pinned: str, localAvailable: bool, remoteAvailable: bool): Routing = {
  val account = chosenAccount(s, pinned)
  val runner = chosenRunner(localAvailable, remoteAvailable)
  val failure = if (account == "") (if (pinned != "") AccountIneligible else CapabilityUnavailable) else if (runner == NoRunner) CapabilityUnavailable else NoFailure
  { ...s, requests: s.requests.append({ id: id, pinned: pinned, account: if (failure == NoFailure) account else "", runner: if (failure == NoFailure) runner else NoRunner, phase: if (failure == NoFailure) Routed else RouteFailed, failure: failure }) }
}
pure def alwaysRunningRequestHasARunner(s: Routing): bool = s.requests.every(r => (r.phase == Routed or r.phase == Running or r.phase == Succeeded) implies r.runner != NoRunner)
pure def stepRunnerIsChosenOnce(before: Routing, after: Routing): bool =
  before.requests.every(b => after.requests.some(a => a.id == b.id and a.runner == b.runner))
pure def sometimesLocalSucceeded(s: Routing): bool = s.requests.some(r => r.runner == LocalRunner and r.phase == Succeeded)
pure def sometimesRemoteSucceeded(s: Routing): bool = s.requests.some(r => r.runner == RemoteRunner and r.phase == Succeeded)
```

### A request uses only a connected account the agent holds

The agent's accounts are the ones the user connected to it, with the [account status](./accountValues.md) connectors share. Only a connected account is eligible, as an account policy admits by default; a pending, disabled, revoked, reauthorization-needing or failed one is not. Routing and the start of work each check eligibility, so an account revoked or released between them fails the request instead of running under it.

```quint
pure val accountIdValues = Set("acct-a", "acct-b")
pure val costValues = Set(1, 2)
pure def canConnectAccount(s: Routing, accountId: str, cost: int): bool = accountId != "" and cost >= 0 and not(s.accounts.some(a => a.id == accountId))
pure def connectAccount(s: Routing, accountId: str, cost: int): Routing = { ...s, accounts: s.accounts.append({ id: accountId, status: A::AccountConnected, cost: cost }) }
pure def canSetAccountStatus(s: Routing, accountId: str, status: A::AccountStatus): bool = s.accounts.some(a => a.id == accountId)
pure def setAccountStatus(s: Routing, accountId: str, status: A::AccountStatus): Routing = { ...s, accounts: s.accounts.listMap(a => if (a.id == accountId) { ...a, status: status } else a) }
pure def canReleaseAccount(s: Routing, accountId: str): bool = s.accounts.some(a => a.id == accountId)
pure def releaseAccount(s: Routing, accountId: str): Routing = { ...s, accounts: s.accounts.select(a => a.id != accountId) }
pure def canStart(s: Routing, id: int): bool = knownRequest(s, id) and requestAt(s, id).phase == Routed
pure def start(s: Routing, id: int): Routing = {
  val ok = isEligible(s, requestAt(s, id).account)
  { ...s, requests: s.requests.listMap(r => if (r.id == id) { ...r, phase: if (ok) Running else RouteFailed, failure: if (ok) NoFailure else AccountIneligible } else r) }
}
pure def stepWorkUsesAHeldConnectedAccount(before: Routing, after: Routing): bool =
  after.requests.every(a => not(a.phase == Routed or a.phase == Running) or before.requests.some(b => b.id == a.id and b.phase == a.phase) or isEligible(before, a.account))
pure def sometimesRevokedBeforeStart(s: Routing): bool = s.requests.some(r => r.phase == RouteFailed and r.failure == AccountIneligible and r.runner != NoRunner)
```

### A pinned account is honored exactly or the request fails

A request may pin the account it wants. Routing uses exactly that account when it is eligible and otherwise fails the request as ineligible; it never substitutes another account.

```quint
pure val pinnedValues = Set("", "acct-a", "acct-c")
pure def alwaysPinnedAccountIsNeverSubstituted(s: Routing): bool = s.requests.every(r => r.pinned == "" or r.account == "" or r.account == r.pinned)
pure def sometimesPinnedRefused(s: Routing): bool = s.requests.some(r => r.pinned != "" and r.failure == AccountIneligible and r.runner == NoRunner)
```

### Without a pin the cheapest eligible account is chosen

Among eligible accounts the one with the lowest cost wins, and the earlier connected account wins a tie, so the same accounts always give the same choice.

```quint
pure def accountCost(s: Routing, accountId: str): int = s.accounts.select(x => x.id == accountId).nthOr(0, noAccount).cost
pure def stepUnpinnedRouteChoosesCheapest(before: Routing, via: str, after: Routing): bool =
  via == "route" implies after.requests.every(a => before.requests.some(b => b.id == a.id) or a.pinned != "" or a.account == "" or (
    eligible(before).every(e => accountCost(before, a.account) <= e.cost)
    and eligible(before).select(e => e.cost == accountCost(before, a.account)).nthOr(0, noAccount).id == a.account))
```

### A failed request carries a typed failure

A request that fails names why: no runner or account was available, the account was ineligible, the remote runner could not be reached, or the request itself failed. Only a remote request can fail as unreachable, and a succeeded request names no failure.

```quint
pure def canFinish(s: Routing, id: int, ok: bool, reachable: bool): bool = knownRequest(s, id) and requestAt(s, id).phase == Running
pure def finish(s: Routing, id: int, ok: bool, reachable: bool): Routing =
  { ...s, requests: s.requests.listMap(r => if (r.id == id) { ...r, phase: if (ok) Succeeded else RouteFailed, failure: if (ok) NoFailure else if (r.runner == RemoteRunner and not(reachable)) RemoteUnreachable else RequestFailed } else r) }
pure def alwaysFailureIsTyped(s: Routing): bool =
  s.requests.every(r => ((r.phase == RouteFailed) iff (r.failure != NoFailure)) and (r.failure == RemoteUnreachable implies r.runner == RemoteRunner))
pure def stepSettledRequestKeepsItsOutcome(before: Routing, after: Routing): bool =
  before.requests.every(b => not(b.phase == Succeeded or b.phase == RouteFailed) or after.requests.some(a => a == b))
pure def sometimesRemoteUnreachable(s: Routing): bool = s.requests.some(r => r.failure == RemoteUnreachable)
pure def alwaysRequestIdentitiesUnique(s: Routing): bool = s.requests.every(r => r.id > 0 and s.requests.select(other => other.id == r.id).length() == 1)
```

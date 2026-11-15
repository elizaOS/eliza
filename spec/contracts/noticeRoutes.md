# Notice routes

A device posts notices on behalf of the agent its owner is signed in to:
results, questions and approvals. When the owner changes, the device must
withdraw the other owner's results and suspend their approvals at once,
and when an owner returns, their suspended approvals may come back only if
nothing about them changed. A tap on a notice is only a request to read:
it opens the exact record the notice was posted for, through authenticated
reads, and never starts, retries, approves or decides anything.

This contract is the client's half of those routes. The native host keeps
the route ledger, the work queue, the foreground checks and the
presentation. Hashed identities are modeled by the values they are hashed
from, so equal inputs give equal identities and different inputs different
ones.

## Story: Keep my notices to the account I am signed in to

> As an owner who signs in and out on one device, I want only my own
> notices to stay posted, and a notice I tap to open only what it was
> posted for.

### The owner fence is published once for each change of owner

Nothing is published before the first session is restored, unless a
session already exists. While a reconnect is in progress and the session
is absent for a moment, nothing is published, so a reconnect to the same owner
never withdraws that owner's results. After that, a change of session
identity, or a failed earlier publication, publishes the fence once and
starts a new generation.

```quint
type OwnerSnapshot = { sessionIdentity: str, hasSession: bool, startupResolved: bool, reconnecting: bool }
type NoticeFence = { initialized: bool, fencedIdentity: str, retryNeeded: bool, generation: int }
type FenceUpdate = { fence: NoticeFence, publish: bool }
pure val freshFence: NoticeFence = { initialized: false, fencedIdentity: "", retryNeeded: false, generation: 0 }
pure def updateFence(fence: NoticeFence, snapshot: OwnerSnapshot): FenceUpdate = {
  val waiting = not(fence.initialized) and not(snapshot.hasSession) and not(snapshot.startupResolved)
  val started = if (fence.initialized) fence else { ...fence, initialized: true, retryNeeded: true }
  if (waiting or (not(snapshot.hasSession) and snapshot.reconnecting)) { fence: if (waiting) fence else started, publish: false }
  else if (snapshot.sessionIdentity == started.fencedIdentity and not(started.retryNeeded)) { fence: started, publish: false }
  else { fence: { ...started, fencedIdentity: snapshot.sessionIdentity, retryNeeded: false, generation: started.generation + 1 }, publish: true }
}
pure val fenceValues: Set[NoticeFence] = Set(
  { initialized: false, fencedIdentity: "", retryNeeded: false, generation: 0 },
  { initialized: true, fencedIdentity: "owner1", retryNeeded: false, generation: 1 },
  { initialized: true, fencedIdentity: "owner1", retryNeeded: true, generation: 2 })
pure val snapshotValues: Set[OwnerSnapshot] = Set(
  { sessionIdentity: "", hasSession: false, startupResolved: false, reconnecting: false },
  { sessionIdentity: "", hasSession: false, startupResolved: true, reconnecting: false },
  { sessionIdentity: "", hasSession: false, startupResolved: true, reconnecting: true },
  { sessionIdentity: "owner1", hasSession: true, startupResolved: true, reconnecting: false },
  { sessionIdentity: "owner2", hasSession: true, startupResolved: true, reconnecting: false })
pure def lawReconnectNeverWithdraws(fence: NoticeFence, snapshot: OwnerSnapshot): bool =
  (not(snapshot.hasSession) and snapshot.reconnecting) implies not(updateFence(fence, snapshot).publish)
pure def lawSameOwnerIsFencedOnce(fence: NoticeFence, snapshot: OwnerSnapshot): bool =
  (fence.initialized and not(fence.retryNeeded) and snapshot.sessionIdentity == fence.fencedIdentity) implies not(updateFence(fence, snapshot).publish)
pure def lawOwnerChangeIsFenced(fence: NoticeFence, snapshot: OwnerSnapshot): bool =
  (fence.initialized and snapshot.hasSession and snapshot.sessionIdentity != fence.fencedIdentity) implies
    (updateFence(fence, snapshot).publish and updateFence(fence, snapshot).fence.generation == fence.generation + 1)
pure def lawNothingIsFencedBeforeStartup(snapshot: OwnerSnapshot): bool =
  (not(snapshot.hasSession) and not(snapshot.startupResolved)) implies not(updateFence(freshFence, snapshot).publish)
```

### A failed fence of the current generation is retried, and a superseded one is forgotten

```quint
pure def fenceFailed(fence: NoticeFence, failedGeneration: int): NoticeFence =
  if (failedGeneration == fence.generation) { ...fence, retryNeeded: true } else fence
pure val failedGenerationValues = Set(0, 1, 2)
pure def lawSupersededFailureChangesNothing(fence: NoticeFence, failedGeneration: int): bool =
  failedGeneration != fence.generation implies fenceFailed(fence, failedGeneration) == fence
pure def lawCurrentFailureIsRetried(fence: NoticeFence, snapshot: OwnerSnapshot): bool =
  (snapshot.hasSession and not(snapshot.reconnecting)) implies updateFence(fenceFailed(fence, fence.generation), snapshot).publish
```

### A tap opens only the exact route it was posted for, in the account it belongs to

The tap is read from the host's ledger. A tap from another scope, origin,
owner or agent than the current connection belongs to another account. A
tap whose notice is no longer posted, or that lacks a route identifier, is
unavailable. After the record is loaded, the tap is read again: if it was
consumed, changed or lost its notice meanwhile, or the connection changed,
nothing is opened.

```quint
type NoticeRoute = { routeScope: str, routeOrigin: str, routeOwner: str, routeAgent: str }
type PendingTap = { token: str, route: NoticeRoute, retained: bool, identifiersPresent: bool, tapRevision: int }
type TapResolution = LookupUnavailable | NoTap | OtherAccount | TapUnavailable | TapReady
pure def resolveTap(lookupOk: bool, tap: PendingTap, bound: NoticeRoute, connectionLive: bool, loaded: bool, latest: PendingTap, stillLive: bool): TapResolution =
  if (not(lookupOk)) LookupUnavailable
  else if (tap.token == "") NoTap
  else if (not(connectionLive) or tap.route != bound) OtherAccount
  else if (not(tap.retained) or not(tap.identifiersPresent) or not(loaded)) TapUnavailable
  else if (not(stillLive) or latest != tap) TapUnavailable
  else TapReady
pure val routeA: NoticeRoute = { routeScope: "s1", routeOrigin: "https://agent.example", routeOwner: "owner1", routeAgent: "agent1" }
pure val boundValues: Set[NoticeRoute] = Set(routeA).union(Set({ ...routeA, routeOwner: "owner2" }))
pure val tapValues: Set[PendingTap] = List(
  { token: "t1", route: routeA, retained: true, identifiersPresent: true, tapRevision: 1 },
  { token: "t1", route: routeA, retained: false, identifiersPresent: true, tapRevision: 1 },
  { token: "", route: routeA, retained: true, identifiersPresent: true, tapRevision: 1 },
  { token: "t1", route: routeA, retained: true, identifiersPresent: true, tapRevision: 2 }
).foldl(Set(), (acc, t) => acc.union(Set(t)))
pure val latestValues = tapValues
pure def lawTapOpensOnlyItsOwnRoute(lookupOk: bool, tap: PendingTap, bound: NoticeRoute, connectionLive: bool, loaded: bool, latest: PendingTap, stillLive: bool): bool =
  resolveTap(lookupOk, tap, bound, connectionLive, loaded, latest, stillLive) == TapReady implies (tap.route == bound and connectionLive and stillLive and tap.retained)
pure def lawChangedTapNeverOpens(lookupOk: bool, tap: PendingTap, bound: NoticeRoute, connectionLive: bool, loaded: bool, latest: PendingTap, stillLive: bool): bool =
  latest != tap implies resolveTap(lookupOk, tap, bound, connectionLive, loaded, latest, stillLive) != TapReady
```

### An approval notice has one identity per approval and is bound to its exact run route

The notice identity depends only on the scope, the run and the approval,
so one approval has one notice whatever workflow version it was posted
under, and reveals nothing about the step. Its binding names the whole
route, including the origin, owner, agent, workflow and version, so a
notice whose route changed is refused by the host. These identities are
installed on devices and never change form.

```quint
type WorkflowNoticeRoute = { noticeScope: str, noticeOrigin: str, noticeOwner: str, noticeAgent: str, workflowId: str, runId: str, versionId: str }
type ApprovalNoticeId = { idScope: str, idRun: str, idProposal: str }
type ApprovalNoticeBinding = { bindingRoute: WorkflowNoticeRoute, bindingProposal: str }
pure def approvalNoticeId(route: WorkflowNoticeRoute, proposal: str): ApprovalNoticeId = { idScope: route.noticeScope, idRun: route.runId, idProposal: proposal }
pure def approvalNoticeBinding(route: WorkflowNoticeRoute, proposal: str): ApprovalNoticeBinding = { bindingRoute: route, bindingProposal: proposal }
pure val workflowRouteA: WorkflowNoticeRoute = { noticeScope: "s1", noticeOrigin: "https://agent.example", noticeOwner: "owner1", noticeAgent: "agent1", workflowId: "w1", runId: "r1", versionId: "v1" }
pure val routeValues: Set[WorkflowNoticeRoute] = Set(workflowRouteA).union(Set({ ...workflowRouteA, versionId: "v2" })).union(Set({ ...workflowRouteA, runId: "r2" }))
pure val otherValues = routeValues
pure def lawOneNoticePerApproval(route: WorkflowNoticeRoute, other: WorkflowNoticeRoute, proposal: str): bool =
  (route.noticeScope == other.noticeScope and route.runId == other.runId) implies approvalNoticeId(route, proposal) == approvalNoticeId(other, proposal)
pure def lawChangedRouteChangesTheBinding(route: WorkflowNoticeRoute, other: WorkflowNoticeRoute, proposal: str): bool =
  route != other implies approvalNoticeBinding(route, proposal) != approvalNoticeBinding(other, proposal)
```

### A suspended approval notice comes back only while nothing about it changed

When its owner returns, a suspended approval notice is posted again
quietly only if the workflow is still present at the same version, the run
is unfinished at that version, its review is neither finished nor being
cancelled, the same approval is still pending with the same binding and
expiry, and the notice has not expired. Otherwise it is withdrawn. If the
session changed during these reads, the decision is stale and nothing
happens. The reads decide nothing and execute nothing.

```quint
type NoticeDecision = ResumeNotice | WithdrawNotice | StaleNotice
type SuspendedNotice = { suspendedVersion: str, expiresAt: int }
type NoticeReads = { sessionValid: bool, workflowRemoved: bool, workflowVersion: str, runVersion: str, runFinished: bool, reviewFinished: bool, cancellationRequested: bool, sameApprovalPending: bool, now: int }
pure def revalidateNotice(notice: SuspendedNotice, reads: NoticeReads): NoticeDecision =
  if (not(reads.sessionValid)) StaleNotice
  else if (reads.workflowRemoved or reads.workflowVersion != notice.suspendedVersion or notice.expiresAt <= reads.now) WithdrawNotice
  else if (reads.runVersion != notice.suspendedVersion or reads.runFinished) WithdrawNotice
  else if (reads.reviewFinished or reads.cancellationRequested) WithdrawNotice
  else if (reads.sameApprovalPending) ResumeNotice
  else WithdrawNotice
pure val currentReads: NoticeReads = { sessionValid: true, workflowRemoved: false, workflowVersion: "v1", runVersion: "v1", runFinished: false, reviewFinished: false, cancellationRequested: false, sameApprovalPending: true, now: 10 }
pure val noticeValues: Set[SuspendedNotice] = Set({ suspendedVersion: "v1", expiresAt: 20 }, { suspendedVersion: "v1", expiresAt: 10 }, { suspendedVersion: "v2", expiresAt: 20 })
pure val readsValues: Set[NoticeReads] = List(
  currentReads, { ...currentReads, sessionValid: false }, { ...currentReads, runFinished: true }, { ...currentReads, workflowVersion: "v2" },
  { ...currentReads, cancellationRequested: true }, { ...currentReads, sameApprovalPending: false }
).foldl(Set(), (acc, r) => acc.union(Set(r)))
pure def lawNoticeResumesOnlyUnchanged(notice: SuspendedNotice, reads: NoticeReads): bool =
  revalidateNotice(notice, reads) == ResumeNotice implies
    (reads.sessionValid and not(reads.workflowRemoved) and reads.workflowVersion == notice.suspendedVersion and reads.runVersion == notice.suspendedVersion and
     not(reads.runFinished) and not(reads.reviewFinished) and not(reads.cancellationRequested) and reads.sameApprovalPending and notice.expiresAt > reads.now)
pure def lawChangedSessionDecidesNothing(notice: SuspendedNotice, reads: NoticeReads): bool =
  not(reads.sessionValid) implies revalidateNotice(notice, reads) == StaleNotice
```

# Notice routes

The device posts notices for the account it is signed in to
([device credential](../signIn/credential.md)): the results, questions and
approvals of the agent on this device. Notices are os's records. The native
host (`android/notifications/`, `NoticeRoutes`, `NoticeDelivery`,
`NoticeTapInbox`) keeps the route ledger, the post receipts, the tap tokens
and the presentation; the renderer client (`src/bridges/notices.vibe`) keeps
the owner fence and the read-only reads that decide a tap or a returning
approval. When the account changes, the device withdraws the other account's
results and suspends its approvals at once; a suspended approval comes back
only while nothing about it changed and its approval
([approvals](../../core/approvals.md)) is still pending. A tap is only a
request to read: it opens the exact record the notice was posted for and
never starts, retries, approves or decides anything.

Hashed identities are modelled by the values they are hashed from, so equal
inputs give equal identities and different inputs different ones.

## Story: Keep my notices to the account I am signed in to

> As an owner who signs in and out on one device, I want only my own notices
> to stay posted, each notice to reach me once, and a notice I tap to open
> only what it was posted for.

### The owner fence is published once for each change of the signed-in account

Nothing is published before the credential is first read, unless it already
names an account. After that, a change of the credential's account, or a
failed earlier publication, publishes the fence once and starts a new fence
generation. Signing out empties the account, so it is a change; an expired
key keeps its account and a cancelled sign-in keeps the active one, so
neither withdraws anything.

```quint
import approvals as A from "../../core/approvals"
import credential as C from "../signIn/credential"
type NoticeFence = { initialized: bool, fencedAccount: C::Account, retryNeeded: bool, generation: int }
type FenceUpdate = { fence: NoticeFence, publish: bool }
pure val freshFence: NoticeFence = { initialized: false, fencedAccount: C::noAccount, retryNeeded: false, generation: 0 }
pure def updateFence(fence: NoticeFence, credential: C::DeviceCredential, credentialRead: bool): FenceUpdate = {
  val account = C::accountOf(credential)
  val waiting = not(fence.initialized) and not(credentialRead) and account == C::noAccount
  val started = if (fence.initialized) fence else { ...fence, initialized: true, retryNeeded: true }
  if (waiting) { fence: fence, publish: false }
  else if (account == started.fencedAccount and not(started.retryNeeded)) { fence: started, publish: false }
  else { fence: { ...started, fencedAccount: account, retryNeeded: false, generation: started.generation + 1 }, publish: true }
}
pure val fenceValues: Set[NoticeFence] = {
  val one = { userId: "u1", organizationId: "o1" }
  List(freshFence, { initialized: true, fencedAccount: one, retryNeeded: false, generation: 1 },
    { initialized: true, fencedAccount: one, retryNeeded: true, generation: 2 },
    { initialized: true, fencedAccount: C::noAccount, retryNeeded: false, generation: 3 }).foldl(Set(), (acc, f) => acc.union(Set(f)))
}
pure val credentialValues: Set[C::DeviceCredential] = {
  val one = { userId: "u1", organizationId: "o1" }
  List(C::initial,
    { ...C::initial, generation: 1, lastVersion: 1, custody: C::Active({ version: 1, credentialId: "c1", account: one, keyExpiresAt: 100 }) },
    { ...C::initial, generation: 2, lastVersion: 1, custody: C::Expired({ account: one }) },
    { ...C::initial, generation: 3, lastVersion: 2, custody: C::Active({ version: 2, credentialId: "c2", account: { ...one, userId: "u2" }, keyExpiresAt: 100 }) }
  ).foldl(Set(), (acc, c) => acc.union(Set(c)))
}
pure def lawSameAccountIsFencedOnce(fence: NoticeFence, credential: C::DeviceCredential, credentialRead: bool): bool =
  (fence.initialized and not(fence.retryNeeded) and C::accountOf(credential) == fence.fencedAccount) implies not(updateFence(fence, credential, credentialRead).publish)
pure def lawAccountChangeIsFenced(fence: NoticeFence, credential: C::DeviceCredential, credentialRead: bool): bool =
  (fence.initialized and C::accountOf(credential) != fence.fencedAccount) implies
    (updateFence(fence, credential, credentialRead).publish and updateFence(fence, credential, credentialRead).fence.generation == fence.generation + 1 and
     updateFence(fence, credential, credentialRead).fence.fencedAccount == C::accountOf(credential))
pure def lawNothingIsFencedBeforeTheCredentialIsRead(credential: C::DeviceCredential): bool =
  C::accountOf(credential) == C::noAccount implies not(updateFence(freshFence, credential, false).publish)
```

### A failed fence publication of the current generation is retried, and a superseded one is forgotten

```quint
pure def fenceFailed(fence: NoticeFence, failedGeneration: int): NoticeFence =
  if (failedGeneration == fence.generation) { ...fence, retryNeeded: true } else fence
pure val failedGenerationValues = Set(0, 1, 2, 3)
pure def lawSupersededFailureIsForgotten(fence: NoticeFence, credential: C::DeviceCredential, failedGeneration: int): bool =
  (fence.initialized and not(fence.retryNeeded) and failedGeneration != fence.generation and C::accountOf(credential) == fence.fencedAccount) implies
    not(updateFence(fenceFailed(fence, failedGeneration), credential, true).publish)
pure def lawCurrentFailureIsRetried(fence: NoticeFence, credential: C::DeviceCredential): bool =
  fence.initialized implies updateFence(fenceFailed(fence, fence.generation), credential, true).publish
```

### A notice is posted at most once, and an uncertain post is never repeated

A pending notice is reserved as dispatching, with a live permit, before the
Android call; a refused permission settles it declined without posting. Only
the live permit may post. A live return settles shown as posted, a definite
not-shown as declined, and a throw as unknown. A failed ledger write after the
call drops the permit and leaves the row dispatching. An interrupted process
or an account change also drops the permit. A dispatching row without its
permit is settled only by reading Android for its exact key: an exact match
records posted, anything else unknown, and that recovery never posts. A row
never returns to pending, so later input with the same receipt cannot post
again. Arming a notice for new content starts a fresh pending row that keeps
only the token serial, so no tap captured on the earlier content opens it.

```quint
type NoticePhase = NoticeNone | NoticePending | NoticeDispatching | NoticePosted | NoticeDeclined | NoticeUnknown | NoticeOpened | NoticeWithdrawn
type NoticeLedger = { phase: NoticePhase, permit: bool, posts: int, tokenSerial: int, tapToken: int, tapAsk: bool }
type PostSettlement = LiveShown | LiveNotShown | LiveThrew | RecoveredExact | RecoveredInexact
pure val emptyNotice: NoticeLedger = { phase: NoticeNone, permit: false, posts: 0, tokenSerial: 0, tapToken: 0, tapAsk: false }
pure def pendNotice(n: NoticeLedger): NoticeLedger = if (n.phase == NoticeNone) { ...n, phase: NoticePending } else n
pure def rearmNotice(n: NoticeLedger): NoticeLedger = { ...emptyNotice, phase: NoticePending, tokenSerial: n.tokenSerial }
pure def reserveNotice(n: NoticeLedger, permitted: bool): NoticeLedger =
  if (n.phase != NoticePending) n else { ...n, phase: if (permitted) NoticeDispatching else NoticeDeclined, permit: permitted }
pure def liveSettlement(settlement: PostSettlement): bool = settlement == LiveShown or settlement == LiveNotShown or settlement == LiveThrew
pure def mayPostSettle(n: NoticeLedger, settlement: PostSettlement): bool = n.phase == NoticeDispatching and n.permit == liveSettlement(settlement)
pure def settleNotice(n: NoticeLedger, settlement: PostSettlement, stored: bool): NoticeLedger = {
  val posts = if (liveSettlement(settlement)) n.posts + 1 else n.posts
  if (not(stored)) { ...n, permit: false, posts: posts }
  else { ...n, permit: false, posts: posts,
    phase: if (settlement == LiveShown or settlement == RecoveredExact) NoticePosted else if (settlement == LiveNotShown) NoticeDeclined else NoticeUnknown }
}
pure def dropPermit(n: NoticeLedger): NoticeLedger = { ...n, permit: false }
pure def withdrawNotice(n: NoticeLedger, tapCleared: bool): NoticeLedger =
  if (n.phase == NoticeNone) n
  else { ...n, phase: NoticeWithdrawn, permit: false, tapToken: if (tapCleared) 0 else n.tapToken, tapAsk: n.tapAsk and not(tapCleared) }
pure def noticeLedgerValid(n: NoticeLedger): bool =
  n.posts >= 0 and n.posts <= 1 and
  (n.permit implies n.phase == NoticeDispatching and n.posts == 0) and
  ((n.phase == NoticeNone or n.phase == NoticePending) implies n.posts == 0 and n.tapToken == 0) and
  n.tapToken >= 0 and n.tapToken <= n.tokenSerial and (n.tapToken == 0 implies not(n.tapAsk))
pure val ledgerValues: Set[NoticeLedger] = List(
  emptyNotice,
  { ...emptyNotice, phase: NoticePending },
  { ...emptyNotice, phase: NoticeDispatching, permit: true },
  { ...emptyNotice, phase: NoticeDispatching },
  { ...emptyNotice, phase: NoticePosted, posts: 1, tokenSerial: 1, tapToken: 1, tapAsk: true }
).foldl(Set(), (acc, l) => acc.union(Set(l)))
pure def lawRecoveryNeverPosts(ledger: NoticeLedger, stored: bool): bool =
  settleNotice(ledger, RecoveredExact, stored).posts == ledger.posts and settleNotice(ledger, RecoveredInexact, stored).posts == ledger.posts
pure def lawNoRowReturnsToPending(ledger: NoticeLedger, permitted: bool, settlement: PostSettlement, stored: bool, tapCleared: bool): bool =
  (ledger.phase != NoticeNone and ledger.phase != NoticePending) implies
    (pendNotice(ledger).phase != NoticePending and reserveNotice(ledger, permitted).phase != NoticePending and
     settleNotice(ledger, settlement, stored).phase != NoticePending and dropPermit(ledger).phase != NoticePending and
     withdrawNotice(ledger, tapCleared).phase != NoticePending)
pure def lawPostingKeepsTheLedgerValid(ledger: NoticeLedger, permitted: bool, settlement: PostSettlement, stored: bool, tapCleared: bool): bool =
  noticeLedgerValid(ledger) implies
    (noticeLedgerValid(pendNotice(ledger)) and noticeLedgerValid(rearmNotice(ledger)) and noticeLedgerValid(reserveNotice(ledger, permitted)) and
     noticeLedgerValid(dropPermit(ledger)) and noticeLedgerValid(withdrawNotice(ledger, tapCleared)) and
     (mayPostSettle(ledger, settlement) implies noticeLedgerValid(settleNotice(ledger, settlement, stored))))
```

### A tap opens only its exact route, in the account it belongs to, and only with the current tap token

Capturing a tap on a dispatching, posted or unknown notice durably assigns a
fresh token, unless the same kind of tap already holds one; a replacement
token makes an older one useless. The tap is then read from the host's
ledger: one from another scope, origin, owner or agent than the current
connection belongs to another account, and one whose notice is no longer
posted or that lacks a route identifier is unavailable. After the record is
loaded, the tap is read again: if it was consumed, changed or lost its notice
meanwhile, or the connection changed, nothing is opened. Consuming needs the
exact current token: it writes the row opened first and clears the token
second, so a fault leaves an opened row with its old token, never a cleared
token on an unopened row. Releasing an Ask tap clears only that token and
keeps the notice.

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
pure val boundValues: Set[NoticeRoute] = {
  val route = { routeScope: "s1", routeOrigin: "agent:local", routeOwner: "u1", routeAgent: "agent1" }
  Set(route).union(Set({ ...route, routeOwner: "u2" }))
}
pure val tapValues: Set[PendingTap] = {
  val tap = { token: "t1", route: { routeScope: "s1", routeOrigin: "agent:local", routeOwner: "u1", routeAgent: "agent1" }, retained: true, identifiersPresent: true, tapRevision: 1 }
  List(tap, { ...tap, retained: false }, { ...tap, token: "" }, { ...tap, tapRevision: 2 }).foldl(Set(), (acc, t) => acc.union(Set(t)))
}
pure val latestValues = tapValues
pure def lawTapOpensOnlyItsOwnRoute(lookupOk: bool, tap: PendingTap, bound: NoticeRoute, connectionLive: bool, loaded: bool, latest: PendingTap, stillLive: bool): bool =
  resolveTap(lookupOk, tap, bound, connectionLive, loaded, latest, stillLive) == TapReady implies (tap.route == bound and connectionLive and stillLive and tap.retained)
pure def lawChangedTapNeverOpens(lookupOk: bool, tap: PendingTap, bound: NoticeRoute, connectionLive: bool, loaded: bool, latest: PendingTap, stillLive: bool): bool =
  latest != tap implies resolveTap(lookupOk, tap, bound, connectionLive, loaded, latest, stillLive) != TapReady
type TapWrite = TapUnwritten | TapOpenedOnly | TapCleared
pure def tapEligible(n: NoticeLedger): bool = n.phase == NoticeDispatching or n.phase == NoticePosted or n.phase == NoticeUnknown
pure def captureTap(n: NoticeLedger, ask: bool): NoticeLedger =
  if (n.tapToken > 0 and n.tapAsk == ask) n else { ...n, tokenSerial: n.tokenSerial + 1, tapToken: n.tokenSerial + 1, tapAsk: ask }
pure def tapMatches(n: NoticeLedger, token: int): bool = n.tapToken > 0 and n.tapToken == token
pure def markOpened(n: NoticeLedger): NoticeLedger = { ...n, phase: NoticeOpened, permit: false, posts: if (n.permit) n.posts + 1 else n.posts }
pure def consumeTap(n: NoticeLedger, write: TapWrite): NoticeLedger =
  if (write == TapUnwritten) n else if (write == TapOpenedOnly) markOpened(n) else { ...markOpened(n), tapToken: 0, tapAsk: false }
pure def releaseTap(n: NoticeLedger): NoticeLedger = { ...n, tapToken: 0, tapAsk: false }
pure val tokenValues = Set(0, 1, 2)
pure def lawOnlyTheCurrentTokenMatches(ledger: NoticeLedger, ask: bool, token: int): bool =
  (noticeLedgerValid(ledger) and captureTap(ledger, ask).tapToken != ledger.tapToken and token == ledger.tapToken) implies not(tapMatches(captureTap(ledger, ask), token))
pure def lawConsumeOpensBeforeClearing(ledger: NoticeLedger, write: TapWrite): bool =
  consumeTap(ledger, write).tapToken < ledger.tapToken implies consumeTap(ledger, write).phase == NoticeOpened
pure def lawTapsKeepTheLedgerValid(ledger: NoticeLedger, ask: bool, write: TapWrite): bool =
  noticeLedgerValid(ledger) implies
    ((tapEligible(ledger) implies noticeLedgerValid(captureTap(ledger, ask))) and noticeLedgerValid(consumeTap(ledger, write)) and noticeLedgerValid(releaseTap(ledger)))
pure def lawOpeningCountsInFlightPost(ledger: NoticeLedger): bool =
  (noticeLedgerValid(ledger) and ledger.permit) implies (markOpened(ledger).posts == 1 and noticeLedgerValid(markOpened(ledger)))
```

### An approval notice has one identity per approval, bound to its exact run route

The notice identity depends only on the scope, the run and the approval, so
one approval has one notice whatever workflow version it was posted under,
and it reveals nothing about the step. Its binding names the whole route,
including the origin, owner, agent, workflow and version, so a notice whose
route changed is refused by the host: a new workflow version keeps the
notice and changes its binding. These identities are installed on devices
and never change form.

```quint
type WorkflowNoticeRoute = { noticeScope: str, noticeOrigin: str, noticeOwner: str, noticeAgent: str, workflowId: str, runId: str, versionId: str }
type ApprovalNoticeId = { idScope: str, idRun: str, idProposal: str }
type ApprovalNoticeBinding = { bindingRoute: WorkflowNoticeRoute, bindingProposal: str }
pure def approvalNoticeId(route: WorkflowNoticeRoute, proposal: str): ApprovalNoticeId = { idScope: route.noticeScope, idRun: route.runId, idProposal: proposal }
pure def approvalNoticeBinding(route: WorkflowNoticeRoute, proposal: str): ApprovalNoticeBinding = { bindingRoute: route, bindingProposal: proposal }
pure val routeValues: Set[WorkflowNoticeRoute] = {
  val route = { noticeScope: "s1", noticeOrigin: "agent:local", noticeOwner: "u1", noticeAgent: "agent1", workflowId: "w1", runId: "r1", versionId: "v1" }
  Set(route).union(Set({ ...route, versionId: "v2" })).union(Set({ ...route, runId: "r2" }))
}
pure val otherValues = routeValues
pure def lawNewVersionKeepsTheNoticeButNotItsBinding(route: WorkflowNoticeRoute, other: WorkflowNoticeRoute, proposal: str): bool =
  (other == { ...route, versionId: other.versionId } and other.versionId != route.versionId) implies
    (approvalNoticeId(route, proposal) == approvalNoticeId(other, proposal) and approvalNoticeBinding(route, proposal) != approvalNoticeBinding(other, proposal))
```

### An approval notice's title is part of its receipt, and a call that names no title means the configured one

A host may post an approval with its own title (`NoticeCoordinator.postApproval`
and `resumeApproval` with a title; none means the configured title), and
decides what that title may reveal. The receipt's digest covers the
identity, the binding and the title, so a later post or resume of the same
approval matches it only with the same title. A recheck that knows no
title, such as a suspension or a status read, matches what Android shows:
the shown title has to reproduce the recorded digest.

```quint
type ApprovalNoticeDigest = { digestId: ApprovalNoticeId, digestBinding: ApprovalNoticeBinding, digestTitle: str }
pure def approvalTitle(configured: str, named: str): str = if (named == "") configured else named
pure def approvalDigest(route: WorkflowNoticeRoute, proposal: str, title: str): ApprovalNoticeDigest =
  { digestId: approvalNoticeId(route, proposal), digestBinding: approvalNoticeBinding(route, proposal), digestTitle: title }
pure def approvalCallMatches(recorded: ApprovalNoticeDigest, route: WorkflowNoticeRoute, proposal: str, configured: str, named: str): bool =
  recorded == approvalDigest(route, proposal, approvalTitle(configured, named))
pure def approvalShownMatches(recorded: ApprovalNoticeDigest, route: WorkflowNoticeRoute, proposal: str, shown: str): bool =
  recorded == approvalDigest(route, proposal, shown)
pure val configuredValues = Set("Approval needed", "Review")
pure val namedValues = Set("", "Review", "Pay 12")
pure val renamedValues = namedValues
pure def lawUnnamedTitleIsTheConfiguredOne(configured: str): bool = approvalTitle(configured, "") == configured
pure def lawAnotherTitleIsAnotherNotice(route: WorkflowNoticeRoute, proposal: str, configured: str, named: str, renamed: str): bool =
  approvalTitle(configured, named) != approvalTitle(configured, renamed) implies
    not(approvalCallMatches(approvalDigest(route, proposal, approvalTitle(configured, named)), route, proposal, configured, renamed))
pure def lawTheShownTitleConfirmsItsOwnReceipt(route: WorkflowNoticeRoute, proposal: str, configured: str, named: str): bool =
  approvalShownMatches(approvalDigest(route, proposal, approvalTitle(configured, named)), route, proposal, approvalTitle(configured, named))
```

### An approval notice is offered or kept only while its approval is pending

A new approval notice is offered only while its approval is `Pending`. When
its account returns, a suspended approval notice is posted again quietly only
if the workflow is still present at the same version, the run is unfinished
at that version, its review is neither finished nor being cancelled, the same
approval is still `Pending` with the same binding and expiry, and the notice
has not expired. A `Terminal` approval withdraws its notice. If the session
changed during these reads, the decision is stale and nothing happens. The
reads decide nothing and execute nothing.

```quint
type NoticeDecision = ResumeNotice | WithdrawNotice | StaleNotice
type SuspendedNotice = { suspendedVersion: str, expiresAt: int }
type NoticeReads = { sessionValid: bool, workflowRemoved: bool, workflowVersion: str, runVersion: str, runFinished: bool, reviewFinished: bool, cancellationRequested: bool, sameBindingAndExpiry: bool, now: int }
pure def approvalOffered(approval: A::Approval): bool = approval.phase == A::Pending
pure def revalidateNotice(notice: SuspendedNotice, reads: NoticeReads, approval: A::Approval): NoticeDecision =
  if (not(reads.sessionValid)) StaleNotice
  else if (reads.workflowRemoved or reads.workflowVersion != notice.suspendedVersion or notice.expiresAt <= reads.now) WithdrawNotice
  else if (reads.runVersion != notice.suspendedVersion or reads.runFinished) WithdrawNotice
  else if (reads.reviewFinished or reads.cancellationRequested) WithdrawNotice
  else if (approvalOffered(approval) and reads.sameBindingAndExpiry) ResumeNotice
  else WithdrawNotice
pure val noticeValues: Set[SuspendedNotice] = Set({ suspendedVersion: "v1", expiresAt: 20 }, { suspendedVersion: "v1", expiresAt: 10 }, { suspendedVersion: "v2", expiresAt: 20 })
pure val readsValues: Set[NoticeReads] = {
  val current = { sessionValid: true, workflowRemoved: false, workflowVersion: "v1", runVersion: "v1", runFinished: false, reviewFinished: false, cancellationRequested: false, sameBindingAndExpiry: true, now: 10 }
  List(current, { ...current, sessionValid: false }, { ...current, runFinished: true }, { ...current, workflowVersion: "v2" },
    { ...current, cancellationRequested: true }, { ...current, sameBindingAndExpiry: false }).foldl(Set(), (acc, r) => acc.union(Set(r)))
}
pure val approvalValues: Set[A::Approval] = List(
  A::initial, { ...A::initial, phase: A::Pending, durable: true, callbackPresent: true }, { ...A::initial, phase: A::Claimed, durable: true },
  { ...A::initial, phase: A::Terminal, durable: false, resolution: A::Selected, desired: A::Selected }
).foldl(Set(), (acc, a) => acc.union(Set(a)))
pure def lawNoticeResumesOnlyUnchangedAndPending(notice: SuspendedNotice, reads: NoticeReads, approval: A::Approval): bool =
  revalidateNotice(notice, reads, approval) == ResumeNotice implies
    (reads.sessionValid and not(reads.workflowRemoved) and reads.workflowVersion == notice.suspendedVersion and reads.runVersion == notice.suspendedVersion and
     not(reads.runFinished) and not(reads.reviewFinished) and not(reads.cancellationRequested) and reads.sameBindingAndExpiry and
     notice.expiresAt > reads.now and approval.phase == A::Pending)
pure def lawTerminalApprovalWithdraws(notice: SuspendedNotice, reads: NoticeReads, approval: A::Approval): bool =
  (reads.sessionValid and approval.phase == A::Terminal) implies revalidateNotice(notice, reads, approval) == WithdrawNotice
pure def lawChangedSessionDecidesNothing(notice: SuspendedNotice, reads: NoticeReads, approval: A::Approval): bool =
  not(reads.sessionValid) implies revalidateNotice(notice, reads, approval) == StaleNotice
```

## Story: Tell my app which workflow notices this phone can present

> As a device owner, I want my app to know how this phone's host presents
> workflow notices before it offers the phone to my agent, so that my agent
> never sends my phone a notice it cannot show.

### The host answers presentation protocol 2, and a renderer presents only through a host that answers it

The bridge's `workflowPresentationCapabilities` answers `{protocol}`, the
one presentation of workflow notices the host implements: a result posted
once under its operation and binding, a receipt, and an approval notice
bound to its exact run route, as the rules above say. This host answers 2.
A renderer that reads another number does not present through the host.

```quint
pure val workflowPresentationProtocol = 2
pure def presentsWorkflowNotices(answeredProtocol: int): bool = answeredProtocol == workflowPresentationProtocol
pure val answeredProtocolValues = Set(1, 2, 3)
pure def lawOnlyProtocolTwoPresents(answeredProtocol: int): bool =
  presentsWorkflowNotices(answeredProtocol) iff (answeredProtocol == 2)
```

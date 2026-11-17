# Owner approvals

The source is `packages/agent/src/api/approval-routes.ts`, with the queue
transitions of `plugins/plugin-assistant/src/services/approval/store.ts` and
the reviewed resolution of `plugins/plugin-calendar/src/mutations/resolve.ts`.
The agent keeps one approval queue for the owner. A producer adds a pending
review; the owner reads the queue with `GET /api/approvals` and decides one
review with `POST /api/approvals/:id/resolve {decision, revision}`. Both
routes are Root only. The calendar mutation ledger (`spec/calendar/mutationLedger.md`)
runs an approved change and reports its outcome; this spec models the
decision, not the provider call. A device request is decided only by the
device decide route of the agent's device actions, never here.

The wire names of the queue phases are `pending`, `approved`, `executing`,
`retryable`, `reconciliation_required`, `done`, `rejected` and `expired`;
`Declined` below is `rejected`. A row's `revision` is an opaque string that
changes whenever any field the owner reviewed (subject, phase, action,
payload, reason, expiry) or its update time changes; the model counts it.

## Story: Resolve what I reviewed, only on the screen

> As the owner, I want my approve or decline in the review dialog to apply
> once, to exactly the request I reviewed, so that nothing said in a
> conversation and no change made after my review can decide it for me.

### Only the owner's review dialog decides an approval

A conversation turn, spoken or typed, never approves or declines a request;
its sender is refused. No other event moves a request out of an open phase.

```quint
type QueueState = Pending | Approved | Executing | Retryable | ReconciliationRequired | Done | Declined | Expired
type ApprovalKind = CalendarChange | DeviceRequest | OtherChange
type ApprovalRow = { id: str, kind: ApprovalKind, phase: QueueState, revision: int, lapsed: bool }
type Approvals = { rows: List[ApprovalRow] }
type Decider = OwnerReview | ConversationTurn
type Decision = Approve | Reject
type ExecutionResult = ChangeSucceeded | ChangeInvalidated | ChangeRetryable | ChangeUnconfirmed
type ResolveKind = KindSucceeded | KindRejected | KindInvalidated | KindRetryable | KindBlocked
type Refusal = NotFound | Stale | Unavailable
type Reply = Resolved({ id: str, kind: ResolveKind }) | Refused({ id: str, refusal: Refusal }) | Listed({ ids: List[str] })
type RouteStep = { state: Approvals, out: List[Reply] }
pure val initial: Approvals = { rows: List() }
pure val absent: ApprovalRow = { id: "", kind: OtherChange, phase: Pending, revision: 0, lapsed: false }
pure val idValues = Set("a1", "a2")
pure val reviewedValues = Set(0, 1, 2)
pure def rowAt(s: Approvals, id: str): ApprovalRow = s.rows.select(r => r.id == id).nthOr(0, absent)
pure def openForDecision(phase: QueueState): bool = phase == Pending or phase == Approved or phase == Retryable
pure def canRequest(s: Approvals, id: str, kind: ApprovalKind): bool = id != "" and rowAt(s, id).id == ""
pure def request(s: Approvals, id: str, kind: ApprovalKind): Approvals = { rows: s.rows.append({ id: id, kind: kind, phase: Pending, revision: 0, lapsed: false }) }
pure def canResolve(s: Approvals, by: Decider): bool = by == OwnerReview
pure def stepOnlyResolveLeavesAnOpenPhase(before: Approvals, via: str, after: Approvals): bool = before.rows.every(r => (openForDecision(r.phase) and rowAt(after, r.id).phase != r.phase) implies via == "resolve")
pure def alwaysRowsAreUnique(s: Approvals): bool = s.rows.every(r => r.id != "" and r.revision >= 0 and s.rows.select(o => o.id == r.id).length() == 1)
```

### A decision applies only to an open request whose revision is the one reviewed

A request that is not open, or whose revision differs from the one the
owner reviewed, is refused as stale (409); one that does not exist, or is not
a calendar change, is not found (404). A refusal changes nothing, except
that a pending request whose expiry has passed becomes expired as it is
refused.

```quint
type Verdict = { phase: QueueState, reply: Reply, changed: bool }
pure def afterExecution(result: ExecutionResult): QueueState = if (result == ChangeSucceeded) Done else if (result == ChangeInvalidated) Expired else if (result == ChangeRetryable) Retryable else ReconciliationRequired
pure def kindOf(result: ExecutionResult): ResolveKind = if (result == ChangeSucceeded) KindSucceeded else if (result == ChangeInvalidated) KindInvalidated else if (result == ChangeRetryable) KindRetryable else KindBlocked
pure def verdict(row: ApprovalRow, decision: Decision, reviewed: int, executorReady: bool, result: ExecutionResult): Verdict = {
  val effective = if (row.lapsed) ChangeInvalidated else result
  if (row.kind != CalendarChange) { phase: row.phase, reply: Refused({ id: row.id, refusal: NotFound }), changed: false }
  else if (not(openForDecision(row.phase)) or row.revision != reviewed) { phase: row.phase, reply: Refused({ id: row.id, refusal: Stale }), changed: false }
  else if (decision == Approve and not(executorReady)) { phase: row.phase, reply: Refused({ id: row.id, refusal: Unavailable }), changed: false }
  else if (row.lapsed and row.phase == Pending) { phase: Expired, reply: Refused({ id: row.id, refusal: Stale }), changed: true }
  else if (decision == Reject) { phase: Declined, reply: Resolved({ id: row.id, kind: KindRejected }), changed: true }
  else { phase: afterExecution(effective), reply: Resolved({ id: row.id, kind: kindOf(effective) }), changed: true }
}
pure def resolve(s: Approvals, by: Decider, id: str, decision: Decision, reviewed: int, executorReady: bool, result: ExecutionResult): RouteStep = {
  val row = rowAt(s, id)
  val v = verdict(row, decision, reviewed, executorReady, result)
  if (row.id == "") { state: s, out: List(Refused({ id: id, refusal: NotFound })) }
  else if (not(v.changed)) { state: s, out: List(v.reply) }
  else { state: { rows: s.rows.listMap(r => if (r.id == id) { ...r, phase: v.phase, revision: r.revision + 1 } else r) }, out: List(v.reply) }
}
pure def isRefusal(reply: Reply): bool = match reply { | Refused(x) => true | _ => false }
pure def lapsedPendingExpires(b: ApprovalRow, a: ApprovalRow): bool = b.phase == Pending and b.lapsed and a.phase == Expired
pure def stepRefusalChangesNothing(before: Approvals, via: str, after: Approvals, out: List[Reply]): bool = out.some(reply => isRefusal(reply)) implies before.rows.every(r => rowAt(after, r.id) == r or lapsedPendingExpires(r, rowAt(after, r.id)))
pure def sometimesLapsedReviewExpired(s: Approvals): bool = s.rows.some(r => r.phase == Expired and r.lapsed and r.revision == 1)
```

### Every decision changes the revision, so the same review decides at most once

A second resolve with the revision the owner reviewed is stale, because the
first one changed it.

```quint
pure def resolvedId(reply: Reply): str = match reply { | Resolved(x) => x.id | _ => "" }
pure def stepDecisionAdvancesRevision(before: Approvals, via: str, after: Approvals, out: List[Reply]): bool = out.every(reply => resolvedId(reply) == "" or rowAt(after, resolvedId(reply)).revision == rowAt(before, resolvedId(reply)).revision + 1)
pure def lawSameReviewDecidesOnce(phase: QueueState, lapsed: bool, decision: Decision, executorReady: bool, result: ExecutionResult): bool = {
  val row = { id: "a1", kind: CalendarChange, phase: phase, revision: 0, lapsed: lapsed }
  val first = verdict(row, decision, 0, executorReady, result)
  first.changed implies verdict({ ...row, phase: first.phase, revision: 1 }, decision, 0, executorReady, result).reply == Refused({ id: "a1", refusal: Stale })
}
```

### Declining never runs the change and approving is never reported as declined

A decline moves an open request to declined and answers `rejected`. An
approval runs the change through the ledger, after approving a pending
request, and answers its outcome: `succeeded` (done), `invalidated` (expired,
always when the request's expiry has passed), `retryable`, or `blocked` when
the outcome is unconfirmed and needs reconciliation.

```quint
pure def lawDeclineNeverRuns(phase: QueueState, lapsed: bool, executorReady: bool, result: ExecutionResult): bool = {
  val v = verdict({ id: "a1", kind: CalendarChange, phase: phase, revision: 0, lapsed: lapsed }, Reject, 0, executorReady, result)
  (v.phase == phase or v.phase == Declined or v.phase == Expired) and (isRefusal(v.reply) or v.reply == Resolved({ id: "a1", kind: KindRejected }))
}
pure def lawApproveIsNeverDeclined(phase: QueueState, lapsed: bool, executorReady: bool, result: ExecutionResult): bool = {
  val v = verdict({ id: "a1", kind: CalendarChange, phase: phase, revision: 0, lapsed: lapsed }, Approve, 0, executorReady, result)
  v.phase != Declined and v.reply != Resolved({ id: "a1", kind: KindRejected })
}
pure def sometimesChangeDone(s: Approvals): bool = s.rows.some(r => r.phase == Done)
pure def sometimesDeclined(s: Approvals): bool = s.rows.some(r => r.phase == Declined)
pure def sometimesRetryAfterRefusedAttempt(s: Approvals): bool = s.rows.some(r => r.phase == Retryable and r.revision >= 2)
pure def sometimesNeedsReconciliation(s: Approvals): bool = s.rows.some(r => r.phase == ReconciliationRequired)
```

### An approval with no calendar executor changes nothing

When the calendar executor is not available the route answers 503 and
nothing is approved or changed.

```quint
pure def lawMissingExecutorApprovesNothing(phase: QueueState, lapsed: bool, result: ExecutionResult): bool = {
  val v = verdict({ id: "a1", kind: CalendarChange, phase: phase, revision: 0, lapsed: lapsed }, Approve, 0, false, result)
  not(v.changed) and v.phase == phase
}
```

### A device request is never decided by this route

Device requests belong to the device decide route, which checks the
enrolled device's binding; here they read as not found.

```quint
pure def lawDeviceRequestNotFoundHere(phase: QueueState, lapsed: bool, decision: Decision, executorReady: bool, result: ExecutionResult): bool =
  verdict({ id: "a1", kind: DeviceRequest, phase: phase, revision: 0, lapsed: lapsed }, decision, 0, executorReady, result) == { phase: phase, reply: Refused({ id: "a1", refusal: NotFound }), changed: false }
```

### A passed expiry changes no phase until a decision meets it

The queue expires a request lazily: only a decision that meets a pending
request past its expiry turns it to expired.

```quint
pure def canLapse(s: Approvals, id: str): bool = openForDecision(rowAt(s, id).phase) and not(rowAt(s, id).lapsed) and rowAt(s, id).id != ""
pure def lapse(s: Approvals, id: str): Approvals = { rows: s.rows.listMap(r => if (r.id == id) { ...r, lapsed: true } else r) }
pure def stepLapseKeepsPhaseAndRevision(before: Approvals, via: str, after: Approvals): bool = via == "lapse" implies before.rows.every(r => rowAt(after, r.id).phase == r.phase and rowAt(after, r.id).revision == r.revision)
```

## Story: See the approvals waiting for me

> As the owner, I want to list my approvals by phase, so that I can review
> each one before I decide it.

The reply is `{ownerEntityId, approvals}`; each row carries `id`, `state`,
`requestedBy`, `subjectUserId`, `action`, `payload`, `channel`, `reason`,
`expiresAt`, `resolvedAt`, `resolvedBy`, `resolutionReason`, `execution`,
`createdAt`, `updatedAt` and `revision`. The decoder reads an absent `state`
as `pending` and `all` as every phase, and refuses any other value (400); an
absent `limit` is 50, and a limit that is not a positive decimal is refused
(400).

### The list shows at most 500 requests, newest first, and never a device request

Listing reads the queue and changes nothing.

```quint
type PhaseFilter = AllPhases | OnlyPhase({ phase: QueueState })
type PageQuery = { phases: PhaseFilter, limit: int }
pure val queryValues = Set({ phases: AllPhases, limit: 500 }, { phases: AllPhases, limit: 1 }, { phases: AllPhases, limit: 900 }, { phases: OnlyPhase({ phase: Pending }), limit: 50 }, { phases: OnlyPhase({ phase: Done }), limit: 50 }, { phases: AllPhases, limit: 0 })
pure def pageSize(limit: int): int = if (limit > 500) 500 else limit
pure def matchesFilter(wanted: PhaseFilter, phase: QueueState): bool = match wanted { | AllPhases => true | OnlyPhase(f) => f.phase == phase }
pure def listedIds(s: Approvals, query: PageQuery): List[str] = s.rows.foldl(List(), (acc, r) => if (r.kind != DeviceRequest and matchesFilter(query.phases, r.phase)) List(r.id).concat(acc) else acc).foldl(List(), (acc, id) => if (acc.length() < pageSize(query.limit)) acc.append(id) else acc)
pure def canList(s: Approvals, query: PageQuery): bool = query.limit >= 1
pure def list(s: Approvals, query: PageQuery): RouteStep = { state: s, out: List(Listed({ ids: listedIds(s, query) })) }
pure def listedOf(reply: Reply): List[str] = match reply { | Listed(x) => x.ids | _ => List() }
pure def stepListingIsBoundedAndHidesDeviceRequests(before: Approvals, via: str, after: Approvals, out: List[Reply]): bool = via == "list" implies (after == before and out.every(reply => listedOf(reply).length() <= 500 and listedOf(reply).every(id => rowAt(before, id).id == id and rowAt(before, id).kind != DeviceRequest)))
pure def sometimesDeviceRequestBesideReview(s: Approvals): bool = s.rows.some(r => r.kind == DeviceRequest) and s.rows.some(r => r.kind == CalendarChange)
```

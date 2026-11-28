# Owner approvals

The owner's approval queue as the optional `@elizaos/agent/approvals` module
serves it: `GET /api/approvals` lists it and
`POST /api/approvals/:id/resolve {decision, revision}` decides one request.
Both routes are Root only. The sources are
`packages/agent/src/api/approval-routes.ts`, the queue transitions of
`plugins/plugin-assistant/src/services/approval/store.ts` and the reviewed
resolution of `plugins/plugin-calendar/src/mutations/resolve.ts`. A
producer adds a pending request. The calendar mutation ledger
(`spec/calendar/mutationLedger.md`) runs an approved
calendar change and reports its outcome, which this spec takes as given.
Device requests are not in this queue: device actions
(`spec/agent/deviceActions/index.md`) holds them and decides them only by its own decide route.

The wire names of the phases are `pending`, `approved`, `retryable`,
`reconciliation_required`, `done`, `rejected` and `expired`, plus the
ledger's in-flight `executing`, which no decision meets; `Declined` below
is `rejected`. A row's `revision` is the JSON array
`[id, subjectUserId, state, action, payload, reason, expiresAt, updatedAt]`,
which a client recomputes from the listed row; it changes whenever a field
the owner reviewed or the update time changes. The model counts it.

## Story: Resolve what I reviewed, only on the screen

> As the owner, I want my approve or decline in the review dialog to apply
> once, to exactly the request I reviewed, so that nothing said in a
> conversation and no change made after my review can decide it for me.

### Only the resolve route moves a request out of an open phase

A request is open while it is pending, approved or retryable. No
conversation turn, spoken or typed, and no action resolves a request:
develop's owner-message resolution is not kept.

```quint
type Phase = Pending | Approved | Retryable | ReconciliationRequired | Done | Declined | Expired
type ApprovalKind = CalendarChange | OtherChange
type ApprovalRow = { kind: ApprovalKind, phase: Phase, revision: int, lapsed: bool }
type Queue = { rows: str -> ApprovalRow, newestFirst: List[str] }
type Decision = Approve | Reject
type LedgerResult = ChangeSucceeded | ChangeInvalidated | ChangeRetryable | ChangeUnconfirmed
type ResolveKind = KindSucceeded | KindRejected | KindInvalidated | KindRetryable | KindBlocked
type Refusal = NotFound | Stale | Unavailable
type PhaseFilter = AllPhases | OnlyPhase({ phase: Phase })
type Reply = Resolved({ id: str, kind: ResolveKind }) | Refused({ id: str, refusal: Refusal }) | Listed({ ids: List[str], phases: PhaseFilter })
type RouteStep = { state: Queue, out: List[Reply] }
pure val initial: Queue = { rows: Map(), newestFirst: List() }
pure val absent: ApprovalRow = { kind: OtherChange, phase: Pending, revision: 0, lapsed: false }
pure val idValues = Set("a1", "a2")
pure val reviewedValues = Set(0, 1, 2)
pure def known(s: Queue, id: str): bool = s.rows.keys().contains(id)
pure def rowAt(s: Queue, id: str): ApprovalRow = if (s.rows.keys().contains(id)) s.rows.get(id) else absent
pure def isOpen(phase: Phase): bool = phase == Pending or phase == Approved or phase == Retryable
pure def canRequest(s: Queue, id: str, kind: ApprovalKind): bool = id != "" and not(known(s, id))
pure def request(s: Queue, id: str, kind: ApprovalKind): Queue = { rows: s.rows.put(id, { ...absent, kind: kind }), newestFirst: List(id).concat(s.newestFirst) }
pure def alwaysListedIdsAreKnown(s: Queue): bool = s.newestFirst.every(id => id != "" and known(s, id))
pure def stepOnlyResolveLeavesAnOpenPhase(before: Queue, via: str, after: Queue): bool = before.newestFirst.every(id => (isOpen(rowAt(before, id).phase) and rowAt(after, id).phase != rowAt(before, id).phase) implies via == "resolve")
```

### A decision applies only to an open calendar request whose revision is the one reviewed

An unknown request, or one that is not a calendar change, is not found
(404). A request that is not open, or whose revision differs from the one
reviewed, is stale (409). A refusal changes nothing, except that a pending
request whose expiry has passed becomes expired as it is refused.

```quint
type Verdict = { phase: Phase, reply: Reply, changed: bool }
pure def afterLedger(result: LedgerResult): Phase = if (result == ChangeSucceeded) Done else if (result == ChangeInvalidated) Expired else if (result == ChangeRetryable) Retryable else ReconciliationRequired
pure def kindOf(result: LedgerResult): ResolveKind = if (result == ChangeSucceeded) KindSucceeded else if (result == ChangeInvalidated) KindInvalidated else if (result == ChangeRetryable) KindRetryable else KindBlocked
pure def verdict(id: str, row: ApprovalRow, decision: Decision, reviewed: int, executorReady: bool, result: LedgerResult): Verdict = {
  val effective = if (row.lapsed) ChangeInvalidated else result
  if (row.kind != CalendarChange) { phase: row.phase, reply: Refused({ id: id, refusal: NotFound }), changed: false }
  else if (not(isOpen(row.phase)) or row.revision != reviewed) { phase: row.phase, reply: Refused({ id: id, refusal: Stale }), changed: false }
  else if (decision == Approve and not(executorReady)) { phase: row.phase, reply: Refused({ id: id, refusal: Unavailable }), changed: false }
  else if (row.lapsed and row.phase == Pending) { phase: Expired, reply: Refused({ id: id, refusal: Stale }), changed: true }
  else if (decision == Reject) { phase: Declined, reply: Resolved({ id: id, kind: KindRejected }), changed: true }
  else { phase: afterLedger(effective), reply: Resolved({ id: id, kind: kindOf(effective) }), changed: true }
}
pure def resolve(s: Queue, id: str, decision: Decision, reviewed: int, executorReady: bool, result: LedgerResult): RouteStep = {
  val row = rowAt(s, id)
  val v = verdict(id, row, decision, reviewed, executorReady, result)
  if (not(known(s, id))) { state: s, out: List(Refused({ id: id, refusal: NotFound })) }
  else if (not(v.changed)) { state: s, out: List(v.reply) }
  else { state: { ...s, rows: s.rows.put(id, { ...row, phase: v.phase, revision: row.revision + 1 }) }, out: List(v.reply) }
}
pure def isRefusal(reply: Reply): bool = match reply { | Refused(x) => true | _ => false }
pure def lapsedPendingExpires(b: ApprovalRow, a: ApprovalRow): bool = b.phase == Pending and b.lapsed and a.phase == Expired
pure def stepRefusalChangesNothing(before: Queue, via: str, after: Queue, out: List[Reply]): bool = out.some(reply => isRefusal(reply)) implies before.newestFirst.every(id => rowAt(after, id) == rowAt(before, id) or lapsedPendingExpires(rowAt(before, id), rowAt(after, id)))
pure def lawOtherKindIsNotFoundHere(phase: Phase, lapsed: bool, decision: Decision, executorReady: bool, result: LedgerResult): bool =
  verdict("a1", { kind: OtherChange, phase: phase, revision: 0, lapsed: lapsed }, decision, 0, executorReady, result) == { phase: phase, reply: Refused({ id: "a1", refusal: NotFound }), changed: false }
pure def sometimesLapsedReviewExpired(s: Queue): bool = s.newestFirst.some(id => rowAt(s, id).phase == Expired and rowAt(s, id).lapsed and rowAt(s, id).revision == 1)
pure def sometimesOtherKindWaits(s: Queue): bool = s.newestFirst.some(id => rowAt(s, id).kind == OtherChange) and s.newestFirst.some(id => rowAt(s, id).phase == Done)
```

### Every decision changes the revision, so one review decides at most once

A second resolve with the revision the owner reviewed is stale, because
the first one changed it.

```quint
pure def resolvedId(reply: Reply): str = match reply { | Resolved(x) => x.id | _ => "" }
pure def stepDecisionAdvancesRevision(before: Queue, via: str, after: Queue, out: List[Reply]): bool = out.every(reply => resolvedId(reply) == "" or rowAt(after, resolvedId(reply)).revision == rowAt(before, resolvedId(reply)).revision + 1)
pure def lawSameReviewDecidesOnce(phase: Phase, lapsed: bool, decision: Decision, executorReady: bool, result: LedgerResult): bool = {
  val row = { kind: CalendarChange, phase: phase, revision: 0, lapsed: lapsed }
  val first = verdict("a1", row, decision, 0, executorReady, result)
  first.changed implies verdict("a1", { ...row, phase: first.phase, revision: 1 }, decision, 0, executorReady, result).reply == Refused({ id: "a1", refusal: Stale })
}
```

### Declining never runs the change, and approving never declines

The reply is `{requestId, decision, kind, text?, failure?}`. A decline
moves an eligible open request to declined and answers `rejected`. An
eligible approval asks the ledger to run the change and answers its
outcome: `succeeded` (done), `invalidated` (expired), `retryable`, or
`blocked` when the outcome is unconfirmed and needs reconciliation.
An eligible approval of a lapsed approved or retryable request answers
`invalidated` without running the change. An approval never declines the
request or answers `rejected`.

```quint
pure def lawDeclineNeverRuns(phase: Phase, lapsed: bool, executorReady: bool, result: LedgerResult): bool = {
  val v = verdict("a1", { kind: CalendarChange, phase: phase, revision: 0, lapsed: lapsed }, Reject, 0, executorReady, result)
  (v.phase == phase or v.phase == Declined or v.phase == Expired) and (isRefusal(v.reply) or v.reply == Resolved({ id: "a1", kind: KindRejected }))
}
pure def lawApproveIsNeverDeclined(phase: Phase, lapsed: bool, executorReady: bool, result: LedgerResult): bool = {
  val v = verdict("a1", { kind: CalendarChange, phase: phase, revision: 0, lapsed: lapsed }, Approve, 0, executorReady, result)
  (v.changed implies v.phase != Declined) and v.reply != Resolved({ id: "a1", kind: KindRejected })
}
pure def sometimesChangeDone(s: Queue): bool = s.newestFirst.some(id => rowAt(s, id).phase == Done)
pure def sometimesDeclined(s: Queue): bool = s.newestFirst.some(id => rowAt(s, id).phase == Declined)
pure def sometimesRetryAfterRefusedAttempt(s: Queue): bool = s.newestFirst.some(id => rowAt(s, id).phase == Retryable and rowAt(s, id).revision >= 2)
pure def sometimesNeedsReconciliation(s: Queue): bool = s.newestFirst.some(id => rowAt(s, id).phase == ReconciliationRequired)
```

### Without the calendar executor an approval changes nothing

The route answers 503 and nothing is approved or changed.

```quint
pure def lawMissingExecutorApprovesNothing(phase: Phase, lapsed: bool, result: LedgerResult): bool = {
  val v = verdict("a1", { kind: CalendarChange, phase: phase, revision: 0, lapsed: lapsed }, Approve, 0, false, result)
  not(v.changed) and v.phase == phase
}
```

### A passed expiry changes no phase and no revision until a decision meets it

The queue handles expiry when a decision presents the current revision
and, for approval, the calendar executor is available. A lapsed pending
request expires and the queue refuses the decision as stale.

```quint
pure def canLapse(s: Queue, id: str): bool = known(s, id) and isOpen(rowAt(s, id).phase) and not(rowAt(s, id).lapsed)
pure def lapse(s: Queue, id: str): Queue = { ...s, rows: s.rows.put(id, { ...rowAt(s, id), lapsed: true }) }
pure def stepLapseKeepsPhaseAndRevision(before: Queue, via: str, after: Queue): bool = via == "lapse" implies before.newestFirst.every(id => rowAt(after, id).phase == rowAt(before, id).phase and rowAt(after, id).revision == rowAt(before, id).revision)
```

## Story: See the requests waiting for me

> As the owner, I want to list my approval requests by phase, newest
> first, so that my client can show the one I am about to review.

### The list shows at most 500 requests of the asked phase, newest first, and changes nothing

The reply is `{ownerEntityId, approvals}`; each row carries `id`, `state`,
`subjectUserId`, `action`, `payload`, `reason`, `expiresAt`, `createdAt`,
`updatedAt` and `revision`. The shell decodes an absent `state` as
`pending` and `all` as every phase, and refuses any other unknown value
(400); an absent `limit` is 50, and one that is not a positive decimal is
refused (400).

```quint
type PageQuery = { phases: PhaseFilter, limit: int }
pure val queryValues = Set({ phases: AllPhases, limit: 500 }, { phases: AllPhases, limit: 1 }, { phases: AllPhases, limit: 900 }, { phases: OnlyPhase({ phase: Pending }), limit: 50 }, { phases: OnlyPhase({ phase: Done }), limit: 50 }, { phases: AllPhases, limit: 0 })
pure def pageSize(limit: int): int = if (limit > 500) 500 else limit
pure def matchesFilter(wanted: PhaseFilter, phase: Phase): bool = match wanted { | AllPhases => true | OnlyPhase(f) => f.phase == phase }
pure def listedIds(s: Queue, query: PageQuery): List[str] = s.newestFirst.select(id => matchesFilter(query.phases, rowAt(s, id).phase)).foldl(List(), (acc, id) => if (acc.length() < pageSize(query.limit)) acc.append(id) else acc)
pure def canList(s: Queue, query: PageQuery): bool = query.limit >= 1
pure def list(s: Queue, query: PageQuery): RouteStep = { state: s, out: List(Listed({ ids: listedIds(s, query), phases: query.phases })) }
pure def listingFits(s: Queue, reply: Reply): bool = match reply { | Listed(x) => x.ids.length() <= 500 and x.ids.every(id => known(s, id) and matchesFilter(x.phases, rowAt(s, id).phase)) | _ => true }
pure def stepListingIsBoundedAndChangesNothing(before: Queue, via: str, after: Queue, out: List[Reply]): bool = via == "list" implies (after == before and out.every(reply => listingFits(before, reply)))
pure def sometimesTwoListed(s: Queue): bool = listedIds(s, { phases: AllPhases, limit: 50 }).length() == 2
```

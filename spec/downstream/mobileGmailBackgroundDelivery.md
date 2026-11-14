# Android Gmail background history and notice delivery

AlphaPhone `8d44dfe52` binds `GmailBackground.java` and
`GmailDeliveryWorker.java` to Eliza `c518127a`'s
`MailBackgroundDelivery.java`, `MailHistoryReconciliation.java` and
`MailNoticePoster.java` in `plugin-native-notifications`. Alpha uses the
encrypted `gmail-background:v1` slot and the production Cloud credential.
[Renderer Gmail notice custody](./alpha/gmailNoticeCustody.md) owns opening
Inbox and the Ask excerpt. Native persists only mailbox metadata and
notification identities. It never reads bodies or mutates Gmail.

## Story: Receive notices for new unread Inbox mail on the currently selected account

### A verified selection owns its schedule and cursor

Foreground selection starts an increasing attempt before enqueueing native
work. An unadmitted enqueue releases only its own latest attempt. Workers
and pending taps are fenced while a selection is being verified. Under
the credential lifecycle lock, the producer checks the reset marker, the
exact credential ID and digest of its stored bytes and the saved binding
generation. The remote checks independently pin Cloud user, organization
and a connected selected grant with `google.gmail.triage`.

A same grant, credential digest and account reference keeps its generation
and existing cursor. A changed selection cancels old notices and work,
then writes a fresh binding before scheduling. If the write fails, the
previous durable binding can remain, though its external work and notices
may already have been cancelled. A failed or unqueued current attempt
unblocks the saved selection. A stale attempt cannot clear a newer one.
Proof exposed the invariant that a pending grant always owns a positive
attempt, including after scoped withdrawal of a different saved grant.
Targeted withdrawal of a pending-only grant preserves the unrelated
saved grant. Removing a saved grant can preserve a different in-flight
selection. Credential replacement invokes full withdrawal. A pending
reset fences admission and resuming a stale saved binding attempts full
withdrawal. Removal precedes cancellation of external notices and work.

WorkManager updates the unique 15-minute periodic job and keeps a unique
immediate catch-up job if already enqueued. Both require connectivity and
carry the binding generation. Backoff starts at 30 seconds. Android
can defer either job. Resume reschedules a locally verified saved binding.
An absent job generation fails before synchronization. The model numbers
valid grants and generations without representing credentials or malformed
bridge arguments, which cannot commit a new binding.

```quint
type NoticePhase = NoNotice | PendingNotice | ReservedNotice | PostedNotice | UnknownNotice | DeniedNotice | WithdrawnNotice | OpenedNotice
type Delivery = { attempt: int, pendingGrant: int, generation: int, grant: int, history: int, continuation: bool, pageFloor: int, authRefusals: int,
  notice: NoticePhase, postPermit: bool, tap: bool, asks: bool }
pure val initial: Delivery = { attempt: 0, pendingGrant: 0, generation: 0, grant: 0, history: 0, continuation: false, pageFloor: 0, authRefusals: 0,
  notice: NoNotice, postPermit: false, tap: false, asks: false }
pure val grantIdValues = Set(0, 1, 2)
pure def ownsBinding(s: Delivery): bool = s.grant > 0 and s.pendingGrant == 0
pure def canSelectGrant(s: Delivery, grantId: int): bool = grantId > 0
pure def selectGrant(s: Delivery, grantId: int): Delivery =
  { ...s, attempt: s.attempt + 1, pendingGrant: grantId, postPermit: false }
type SelectionReply = VerifiedSame | VerifiedDifferent | SelectionRefused
pure def canSettleSelection(s: Delivery): bool = s.pendingGrant > 0
pure def settleSelection(s: Delivery, latestAttempt: bool, selectionReply: SelectionReply, committed: bool): Delivery =
  if (not(latestAttempt)) s
  else if (selectionReply == VerifiedDifferent and committed)
    { ...initial, attempt: s.attempt, generation: s.attempt, grant: s.pendingGrant }
  else { ...s, pendingGrant: 0 }
pure def canWithdrawGrant(s: Delivery, grantId: int): bool =
  (s.grant > 0 or s.pendingGrant > 0) and (grantId == 0 or grantId == s.grant or grantId == s.pendingGrant)
pure def withdrawGrant(s: Delivery, grantId: int, removed: bool): Delivery = {
  val clearsAttempt = grantId == 0 or s.pendingGrant == 0 or grantId == s.pendingGrant
  val pending = if (clearsAttempt) 0 else s.pendingGrant
  val attempt = if (clearsAttempt) s.attempt + 1 else s.attempt
  if (grantId != 0 and grantId != s.grant)
    { ...s, attempt: s.attempt + 1, pendingGrant: 0, postPermit: false }
  else if (removed) { ...initial, attempt: attempt, pendingGrant: pending }
  else { ...s, attempt: attempt, pendingGrant: pending, postPermit: false }
}
pure def alwaysBindingCoordinates(s: Delivery): bool =
  s.attempt >= 0 and s.generation >= 0 and s.generation <= s.attempt and s.pendingGrant >= 0 and s.grant >= 0 and
  ((s.grant == 0) == (s.generation == 0)) and (s.pendingGrant > 0 implies s.attempt > 0)
pure def alwaysMetadataHasBinding(s: Delivery): bool =
  s.grant == 0 implies s.history == 0 and not(s.continuation) and s.notice == NoNotice and not(s.tap)
pure def stepReselectionKeepsGeneration(before: Delivery, via: str, after: Delivery): bool =
  via == "selectGrant" implies after.generation == before.generation and after.history == before.history
pure def sometimesCurrentBinding(s: Delivery): bool = ownsBinding(s)
```

### A history page saves every eligible arrival and its continuation before advancing

A job captures the selection attempt and scheduled generation. It
rechecks the stopped signal, credential and binding around network
reads, durable writes and posting. It verifies the remote user and grant
before work and again after each history response before admitting the
page. Cloud requests use fixed production routes and refuse redirects. The
transport caps each response at 1,100,000 raw bytes, with 15-second
connect and 30-second read deadlines.
Alpha processes at most four pages per job, requesting 50 results per
page. Continuation keeps the previous committed start watermark while
retaining the next page token and latest accepted event history. Only a
final page with matching checkpoint advances the committed watermark.
An empty intermediate page keeps the previous event floor. A baseline
records a starting revision without claiming missed mail. A reset
clears the cursor, marks expiry and requires a new quiet baseline.
Both set the incomplete catch-up flag.

History identifiers are positive decimal strings up to 20 digits,
compared as exact integers. A current page echoes the selected grant
and start. At most 2,000 events are accepted. Each canonical event ID
is unique within the page and binds its history, type and message.
Events are nondecreasing within a page, strictly newer than the start
and prior page event watermark and at most the response history.
A continuation token has at most 4,096 units, differs from the current
token and has no checkpoint. A final page has no continuation and its
checkpoint equals its current history. Event labels are capped at 100.
An available message-added event creates one notice only for unread Inbox
mail outside Spam and Trash, deduplicated by generation, account, grant
and message. Message deletion or removal of the Inbox or Unread label
withdraws that notice. The transaction refuses a retained ledger over
1,000 entries and keeps the old cursor. A committed notice and its
continuation can survive a failed later OS post.

The machine follows one representative retained notice and receives
complete page validity, event ordering and ledger capacity as port facts.
Its history fields use small representative integers in simulation.

```quint
type PageKind = BaselinePage | ResetPage | ContinuePage | FinalPage
type EventEffect = NoEvent | AddNotice | WithdrawNotice
type HistoryPage = { pageKind: PageKind, sameGeneration: bool, verified: bool, wireValid: bool, historyId: int, eventFloor: int, fits: bool, effect: EventEffect }
pure val nextPage: HistoryPage = { pageKind: ContinuePage, sameGeneration: true, verified: true, wireValid: true, historyId: 3, eventFloor: 2, fits: true, effect: AddNotice }
pure val pageValues = Set(nextPage, { ...nextPage, pageKind: BaselinePage, historyId: 1, eventFloor: 0, effect: NoEvent },
  { ...nextPage, pageKind: ResetPage, historyId: 0, eventFloor: 0, effect: NoEvent },
  { ...nextPage, pageKind: FinalPage }, { ...nextPage, pageKind: FinalPage, effect: WithdrawNotice },
  { ...nextPage, pageKind: FinalPage, eventFloor: 0, effect: NoEvent }, { ...nextPage, sameGeneration: false },
  { ...nextPage, wireValid: false }, { ...nextPage, fits: false })
pure def pageOwnsCursor(s: Delivery, page: HistoryPage): bool =
  ownsBinding(s) and page.sameGeneration and page.verified and page.wireValid and page.fits and
  (if (page.pageKind == BaselinePage) s.history == 0 and page.historyId > 0 and page.effect == NoEvent
   else if (page.pageKind == ResetPage) s.history > 0 and page.historyId == 0 and page.effect == NoEvent
   else s.history > 0 and page.historyId >= s.history and
     (if (page.eventFloor == 0) page.effect == NoEvent
      else page.eventFloor > s.history and page.eventFloor > s.pageFloor and page.eventFloor <= page.historyId))
pure def canAcceptHistory(s: Delivery): bool = ownsBinding(s)
pure def acceptHistory(s: Delivery, page: HistoryPage, committed: bool): Delivery = {
  val continues = page.pageKind == ContinuePage
  val nextNotice =
    if (page.effect == AddNotice and s.notice == NoNotice) PendingNotice
    else if (page.effect == WithdrawNotice and s.notice != NoNotice) WithdrawnNotice else s.notice
  if (not(committed and pageOwnsCursor(s, page))) s
  else { ...s, history: if (continues) s.history else page.historyId, continuation: continues,
    pageFloor: if (continues) if (page.eventFloor == 0) s.pageFloor else page.eventFloor else 0, authRefusals: 0,
    notice: nextNotice, postPermit: s.postPermit and nextNotice == ReservedNotice }
}
pure def alwaysCheckpointOwnsContinuation(s: Delivery): bool =
  s.history >= 0 and s.pageFloor >= 0 and
  (if (s.continuation) s.history > 0 and (s.pageFloor == 0 or s.pageFloor > s.history) else s.pageFloor == 0)
pure def lawFullLedgerCannotAdvance(s: Delivery, page: HistoryPage): bool =
  not(page.fits) implies not(pageOwnsCursor(s, page))
pure def stepPageKeepsStartWhileContinuing(before: Delivery, via: str, after: Delivery): bool =
  via == "acceptHistory" and after.continuation implies after.history == before.history
pure def sometimesContinuation(s: Delivery): bool = s.continuation
pure val weight_selectGrant = 3
pure val weight_settleSelection = 5
pure val weight_acceptHistory = 8
```

### Failures preserve the cursor and classify whether the current job retries

A stale generation or cancelled attempt cannot write to the new owner.
WorkManager treats a stale security refusal as complete. Stop or ordinary
transport failures retry. An HTTP 401 anywhere, and 403 or 409 outside
history, finish as unavailable and cancel active notices. A history
403 or 409 increments consecutive refusals without clearing shown
notices. Below three the job retries. At three it reports unavailable
and finishes. An accepted page resets the count. An HTTP 404, 405 or
501 finishes as unsupported. Other HTTP failures retry. A retained
ledger overflow reports capacity reached and retries with the cursor
unchanged. Job exhaustion also retries when more history is required.
The count stays reset if an accepted page commits and later posting fails.

```quint
type WorkerFailure = JobStale | GrantRefused | HistoryRefused | RouteUnsupported | LedgerFull | OrdinaryRetry
type WorkerResult = JobComplete | JobRetry
pure def workerFailureResult(failure: WorkerFailure, refusals: int): WorkerResult =
  if (failure == JobStale or failure == GrantRefused or failure == RouteUnsupported or
      (failure == HistoryRefused and refusals >= 3)) JobComplete else JobRetry
pure def canRecordHistoryRefusal(s: Delivery): bool = ownsBinding(s)
pure def recordHistoryRefusal(s: Delivery, jobCurrent: bool, committed: bool): Delivery =
  if (jobCurrent and committed) { ...s, authRefusals: s.authRefusals + 1 } else s
pure def alwaysAuthRefusalsNonnegative(s: Delivery): bool = s.authRefusals >= 0 and (s.grant == 0 implies s.authRefusals == 0)
pure def stepRefusalPreservesCursor(before: Delivery, via: str, after: Delivery): bool =
  via == "recordHistoryRefusal" implies after.history == before.history and
  after.continuation == before.continuation and after.pageFloor == before.pageFloor
pure def lawHistoryRefusalRetriesBelowLimit(refusals: int): bool =
  refusals < 3 implies workerFailureResult(HistoryRefused, refusals) == JobRetry
```

### A durable post reservation and exact tap protect both delivery and consumption

Only a pending record may reserve posting. Permission denial records
denied. A successful reservation writes dispatching before the OS post.
If a job resumes a durable reservation without its live dispatch
authority it checks the OS key and records posted or uncertain. It does
not post again. A post with no active readback becomes uncertain. The
presenter withdraws older shown notices before a new post, targeting a
cap of five and sparing a captured tap. Old terminal notices and expired
inactive ambiguous posts can be pruned only behind an already committed
watermark at the start of a new batch. The captured tap is spared there
as well. No title, snippet, sender or body enters a background notice.

The bridge first decodes a matching native intent action and exact notice
key. It keeps only the latest scheduled intent, retains that intent for a
resume retry if capture throws, and clears its data after successful
handling. The ledger captures a known posted, dispatching or uncertain
notice and durably assigns a fresh token. Ask also requires an active OS
notice. Native pending reads and consumes reverify the Cloud grant, local
generation and foreground lifecycle. A replacement token prevents an
old consume. Successful consume marks opened and removes its tap before
canceling the OS notice. Release is local and exact: only a matching Ask
token can be removed, leaving the notification available. The model
takes token equality and live native authorization from the port.

```quint
pure def canReserveNotice(s: Delivery): bool = ownsBinding(s) and s.notice == PendingNotice
pure def reserveNotice(s: Delivery, permitted: bool, committed: bool): Delivery =
  if (not(committed)) s
  else { ...s, notice: if (permitted) ReservedNotice else DeniedNotice, postPermit: permitted }
pure def canSettlePost(s: Delivery): bool = ownsBinding(s) and s.notice == ReservedNotice
type PostEvidence = { denied: bool, activeOnPlatform: bool, committed: bool }
pure val postValues = Set({ denied: false, activeOnPlatform: true, committed: true }, { denied: false, activeOnPlatform: false, committed: true },
  { denied: true, activeOnPlatform: false, committed: true }, { denied: false, activeOnPlatform: false, committed: false })
pure def settlePost(s: Delivery, post: PostEvidence): Delivery =
  if (post.committed) { ...s, notice: if (s.postPermit and post.denied) DeniedNotice
    else if (post.activeOnPlatform) PostedNotice else UnknownNotice, postPermit: false }
  else { ...s, postPermit: false }
pure def canLosePostAuthority(s: Delivery): bool = s.postPermit
pure def losePostAuthority(s: Delivery): Delivery = { ...s, postPermit: false }
pure def tapEligible(s: Delivery): bool =
  s.notice == PostedNotice or s.notice == UnknownNotice or s.notice == ReservedNotice
pure def canCaptureTap(s: Delivery, asks: bool, activeOnPlatform: bool): bool =
  ownsBinding(s) and tapEligible(s) and (not(asks) or activeOnPlatform)
pure def captureTap(s: Delivery, asks: bool, activeOnPlatform: bool): Delivery = { ...s, tap: true, asks: asks }
pure def canConsumeTap(s: Delivery, exactAuthorizedTap: bool): bool =
  ownsBinding(s) and s.tap and tapEligible(s) and exactAuthorizedTap
pure def consumeTap(s: Delivery, exactAuthorizedTap: bool, committed: bool): Delivery =
  if (committed) { ...s, tap: false, asks: false, notice: OpenedNotice, postPermit: false } else s
pure def canReleaseTap(s: Delivery, exactToken: bool, foreground: bool): bool =
  ownsBinding(s) and s.tap and s.asks and exactToken and foreground
pure def releaseTap(s: Delivery, exactToken: bool, foreground: bool, committed: bool): Delivery =
  if (committed) { ...s, tap: false, asks: false } else s
pure def alwaysPostPermitHasReservation(s: Delivery): bool = s.postPermit implies ownsBinding(s) and s.notice == ReservedNotice
pure def stepOnlyReservedPermitPosts(before: Delivery, via: str, after: Delivery): bool =
  via == "settlePost" and after.notice == DeniedNotice implies before.postPermit
pure def stepReleaseRetainsNotice(before: Delivery, via: str, after: Delivery): bool =
  via == "releaseTap" implies before.notice == after.notice
pure def sometimesTapCaptured(s: Delivery): bool = s.tap
pure def sometimesAmbiguousNotice(s: Delivery): bool = s.notice == UnknownNotice
pure val weight_reserveNotice = 5
pure val weight_settlePost = 5
pure val weight_captureTap = 12
pure val weight_consumeTap = 10
pure val weight_releaseTap = 10
pure val weight_withdrawGrant = 2
```

Pinned evidence includes `test/gmail-background-binding.test.mjs`,
`test/gmail-background-lock-contention.test.mjs` and
`test/quint-native-gmail-background.test.mjs` from Alpha, plus the pinned
Eliza `MailBackgroundDeliveryTest.java` and
`MailHistoryReconciliationTest.java`. They run real pinned Java sources
with controlled storage, Cloud responses, notification and scheduling
ports. They do not exercise Android's installed scheduler or live Cloud.

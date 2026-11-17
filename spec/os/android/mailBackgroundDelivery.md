# Android mail background history and notice delivery

A consumer binds its mail background entry and delivery worker to Eliza's
`MailBackgroundDelivery.java`, `MailHistoryReconciliation.java` and
`MailNoticePoster.java` in `plugin-native-notifications`, with an encrypted
mail-background slot and the Cloud credential. The
[renderer notice custody](../../inbox/backgroundNotices.md) owns opening the
Inbox and the Ask excerpt. Native keeps only mailbox metadata and notice
identities; it never reads bodies or changes the mailbox. Posting, recovery
and taps follow the shared [notice ledger](./notificationProjection.md);
this spec adds the binding generation and history cursor that admit a mail
notice to it.

## Story: Receive notices for new unread Inbox mail on the currently selected account

> As the person, I want a notice for each new unread Inbox message on the
> account I selected, so that I learn of new mail while the app is closed.

### A verified selection owns its schedule and cursor

Foreground selection starts an increasing attempt before enqueueing native
work; an unadmitted enqueue releases only its own attempt, and a stale
attempt cannot clear a newer one. Under the credential lifecycle lock the
producer checks the reset marker, the stored credential's ID and digest and
the saved binding generation; the remote checks pin the Cloud user,
organization and a connected grant with the mail triage scope. The same
grant, credential and account keep their generation and cursor. A changed
selection cancels old notices and work, then writes a fresh binding before
scheduling; if that write fails the previous binding can remain. Withdrawal
of a pending-only grant keeps an unrelated saved grant, removing a saved
grant can keep a different in-flight selection, and credential replacement
withdraws everything. Removal precedes cancelling external notices and
work.

A unique 15-minute periodic job and a unique immediate catch-up job carry
the binding generation and need connectivity; backoff starts at 30
seconds, and resume reschedules a locally verified saved binding.

```quint
import notificationProjection as N from "./notificationProjection"
type Delivery = { attempt: int, pendingGrant: int, generation: int, grant: int, history: int, continuation: bool, pageFloor: int,
  authRefusals: int, notice: N::NoticeLedger }
pure val initial: Delivery = { attempt: 0, pendingGrant: 0, generation: 0, grant: 0, history: 0, continuation: false, pageFloor: 0,
  authRefusals: 0, notice: N::emptyNotice }
pure val grantIdValues = Set(0, 1, 2)
pure def ownsBinding(s: Delivery): bool = s.grant > 0 and s.pendingGrant == 0
pure def canSelectGrant(s: Delivery, grantId: int): bool = grantId > 0
pure def selectGrant(s: Delivery, grantId: int): Delivery =
  { ...s, attempt: s.attempt + 1, pendingGrant: grantId, notice: N::dropPermit(s.notice) }
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
    { ...s, attempt: s.attempt + 1, pendingGrant: 0, notice: N::dropPermit(s.notice) }
  else if (removed) { ...initial, attempt: attempt, pendingGrant: pending }
  else { ...s, attempt: attempt, pendingGrant: pending, notice: N::dropPermit(s.notice) }
}
pure def alwaysBindingCoordinates(s: Delivery): bool =
  s.attempt >= 0 and s.generation >= 0 and s.generation <= s.attempt and s.pendingGrant >= 0 and s.grant >= 0 and
  ((s.grant == 0) == (s.generation == 0))
pure def alwaysMetadataHasBinding(s: Delivery): bool =
  s.grant == 0 implies s.history == 0 and not(s.continuation) and s.notice.phase == N::NoticeNone and s.notice.tapToken == 0
pure def stepReselectionKeepsGeneration(before: Delivery, via: str, after: Delivery): bool =
  via == "selectGrant" implies after.generation == before.generation and after.history == before.history
pure def sometimesCurrentBinding(s: Delivery): bool = ownsBinding(s)
```

### A pending grant always owns a positive attempt

A pending grant always has a positive attempt, including after a scoped
withdrawal of a different saved grant.

```quint
pure def alwaysPendingGrantHasAttempt(s: Delivery): bool = s.pendingGrant > 0 implies s.attempt > 0
```

### A history page saves every eligible arrival and its continuation before advancing

A job captures the selection attempt and scheduled generation and rechecks
the stop signal, credential and binding around every network read, durable
write and post; it verifies the remote user and grant before work and after
each history response. Cloud requests use fixed routes and refuse
redirects; each response is capped at 1,100,000 raw bytes, with a 15-second
connect and a 30-second read deadline. A job reads at most four pages of 50
results.
Continuation keeps the committed start while retaining the next page token
and the latest accepted event; only a final page with a matching checkpoint
advances the start. An empty intermediate page keeps the previous event
floor. A baseline records a starting revision without claiming missed mail;
a reset clears the cursor and requires a new quiet baseline. History IDs
are positive decimal strings of at most 20 digits, compared as exact
integers, and a current page echoes the selected grant and start. A page
holds at most 2,000 events; each canonical event ID is unique within it and
binds its history, type and message. Events are nondecreasing, newer than
the start and the prior event floor, and no newer than the page's history.
A continuation token has at most 4,096 units, differs from the current one
and has no checkpoint; a final page has no continuation and its checkpoint
equals its history. Event labels are capped at 100. A message-added event
makes one pending notice for unread Inbox mail outside Spam and Trash,
deduplicated by generation, account, grant and message; deletion or removal
of the Inbox or Unread label withdraws it. A ledger that would
exceed 1,000 retained entries refuses the page and keeps the old cursor.
Page validity, event order and ledger capacity are port facts.

```quint
type PageKind = BaselinePage | ResetPage | ContinuePage | FinalPage
type EventEffect = NoEvent | AddNotice | WithdrawNotice
type HistoryPage = { pageKind: PageKind, sameGeneration: bool, verified: bool, wireValid: bool, historyId: int, eventFloor: int, fits: bool, effect: EventEffect }
pure val nextPage: HistoryPage = { pageKind: ContinuePage, sameGeneration: true, verified: true, wireValid: true, historyId: 3, eventFloor: 2, fits: true, effect: AddNotice }
pure val historyPageValues = Set(nextPage, { ...nextPage, pageKind: BaselinePage, historyId: 1, eventFloor: 0, effect: NoEvent },
  { ...nextPage, pageKind: ResetPage, historyId: 0, eventFloor: 0, effect: NoEvent },
  { ...nextPage, pageKind: FinalPage }, { ...nextPage, pageKind: FinalPage, effect: WithdrawNotice },
  { ...nextPage, pageKind: FinalPage, eventFloor: 0, effect: NoEvent }, { ...nextPage, sameGeneration: false },
  { ...nextPage, wireValid: false }, { ...nextPage, fits: false })
pure def pageOwnsCursor(s: Delivery, historyPage: HistoryPage): bool =
  ownsBinding(s) and historyPage.sameGeneration and historyPage.verified and historyPage.wireValid and historyPage.fits and
  (if (historyPage.pageKind == BaselinePage) s.history == 0 and historyPage.historyId > 0 and historyPage.effect == NoEvent
   else if (historyPage.pageKind == ResetPage) s.history > 0 and historyPage.historyId == 0 and historyPage.effect == NoEvent
   else s.history > 0 and historyPage.historyId >= s.history and
     (if (historyPage.eventFloor == 0) historyPage.effect == NoEvent
      else historyPage.eventFloor > s.history and historyPage.eventFloor > s.pageFloor and historyPage.eventFloor <= historyPage.historyId))
pure def pageNotice(n: N::NoticeLedger, effect: EventEffect): N::NoticeLedger =
  if (effect == AddNotice) N::pendNotice(n) else if (effect == WithdrawNotice) N::withdrawNotice(n, false) else n
pure def canAcceptHistory(s: Delivery): bool = ownsBinding(s)
pure def acceptHistory(s: Delivery, historyPage: HistoryPage, committed: bool): Delivery = {
  val continues = historyPage.pageKind == ContinuePage
  if (not(committed and pageOwnsCursor(s, historyPage))) s
  else { ...s, history: if (continues) s.history else historyPage.historyId, continuation: continues,
    pageFloor: if (continues) if (historyPage.eventFloor == 0) s.pageFloor else historyPage.eventFloor else 0, authRefusals: 0,
    notice: pageNotice(s.notice, historyPage.effect) }
}
pure def alwaysCheckpointOwnsContinuation(s: Delivery): bool =
  s.history >= 0 and s.pageFloor >= 0 and
  (if (s.continuation) s.history > 0 and (s.pageFloor == 0 or s.pageFloor > s.history) else s.pageFloor == 0)
pure def lawFullLedgerCannotAdvance(s: Delivery, historyPage: HistoryPage): bool =
  not(historyPage.fits) implies not(pageOwnsCursor(s, historyPage))
pure def stepPageKeepsStartWhileContinuing(before: Delivery, via: str, after: Delivery): bool =
  via == "acceptHistory" and after.continuation implies after.history == before.history
pure def sometimesContinuation(s: Delivery): bool = s.continuation
```

### Failures preserve the cursor and classify whether the current job retries

A stale generation or cancelled attempt cannot write to the new owner, and
WorkManager treats that stale refusal as complete. Stops and ordinary
transport failures retry. An HTTP 401 anywhere, or 403 or 409 outside
history, finishes as unavailable and cancels active notices. A history 403
or 409 counts a consecutive refusal without clearing shown notices; below
three the job retries, and at three it reports unavailable and finishes. An
accepted page resets the count, even if a later post fails. 404, 405 and
501 finish as unsupported; other HTTP failures retry. A full ledger reports
capacity reached and retries with the cursor unchanged, as does a job that
runs out of pages.

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

### Only the current binding posts, opens or releases a mail notice

A job may reserve, settle or recover a pending mail notice only while it
owns the current binding; a selection change or withdrawal drops the post
permit. Mail reads Android back to settle a post: after a live post a
denial settles declined, an active notice shown and anything else
uncertain, since a post with no active readback may still be on screen;
recovery records posted only for an active exact notice. The presenter
withdraws older shown notices before a new post, targeting five and sparing
a captured tap, and prunes old terminal notices only behind a committed
watermark. No title, snippet, sender or body enters
a background notice. The bridge decodes a matching intent action and exact
notice key, keeps only the latest intent and retries it on resume if capture
throws. Ask also requires the notice to be active in Android. Pending reads,
consume and release re-verify the Cloud grant, local generation and
foreground lifecycle.

```quint
pure def canReserveMailNotice(s: Delivery, permitted: bool): bool = ownsBinding(s) and s.notice.phase == N::NoticePending
pure def reserveMailNotice(s: Delivery, permitted: bool, committed: bool): Delivery =
  if (committed) { ...s, notice: N::reserveNotice(s.notice, permitted) } else s
type MailPost = { denied: bool, activeOnPlatform: bool }
pure val postValues = Set({ denied: false, activeOnPlatform: true }, { denied: false, activeOnPlatform: false },
  { denied: true, activeOnPlatform: false })
pure def mailSettlement(permit: bool, post: MailPost): N::PostSettlement =
  if (permit) (if (post.denied) N::LiveNotShown else if (post.activeOnPlatform) N::LiveShown else N::LiveThrew)
  else if (post.activeOnPlatform) N::RecoveredExact else N::RecoveredInexact
pure def canSettleMailPost(s: Delivery, post: MailPost): bool = ownsBinding(s) and s.notice.phase == N::NoticeDispatching
pure def settleMailPost(s: Delivery, post: MailPost, committed: bool): Delivery =
  { ...s, notice: N::settleNotice(s.notice, mailSettlement(s.notice.permit, post), committed) }
pure def lawPostWithoutReadbackIsUncertain(permit: bool, post: MailPost): bool =
  not(post.activeOnPlatform or (permit and post.denied)) implies
    N::settleNotice({ ...N::emptyNotice, phase: N::NoticeDispatching, permit: permit }, mailSettlement(permit, post), true).phase == N::NoticeUnknown
pure def stepOnlyLivePermitDeclines(before: Delivery, via: str, after: Delivery): bool =
  via == "settleMailPost" and after.notice.phase == N::NoticeDeclined implies before.notice.permit
pure def canLosePostAuthority(s: Delivery): bool = s.notice.permit
pure def losePostAuthority(s: Delivery): Delivery = { ...s, notice: N::dropPermit(s.notice) }
pure def canCaptureMailTap(s: Delivery, ask: bool, activeOnPlatform: bool): bool =
  ownsBinding(s) and N::tapEligible(s.notice) and (not(ask) or activeOnPlatform)
pure def captureMailTap(s: Delivery, ask: bool, activeOnPlatform: bool): Delivery = { ...s, notice: N::captureTap(s.notice, ask) }
pure def canConsumeMailTap(s: Delivery, token: int, foreground: bool): bool =
  ownsBinding(s) and foreground and N::tapMatches(s.notice, token)
pure def consumeMailTap(s: Delivery, token: int, foreground: bool, write: N::TapWrite): Delivery =
  { ...s, notice: N::consumeTap(s.notice, write) }
pure def canReleaseMailTap(s: Delivery, token: int, foreground: bool): bool =
  ownsBinding(s) and foreground and N::tapMatches(s.notice, token) and s.notice.tapAsk
pure def releaseMailTap(s: Delivery, token: int, foreground: bool, committed: bool): Delivery =
  if (committed) { ...s, notice: N::releaseTap(s.notice) } else s
pure val tokenValues = Set(0, 1, 2)
pure def alwaysMailLedgerValid(s: Delivery): bool = N::noticeLedgerValid(s.notice) and (s.notice.permit implies ownsBinding(s))
pure def sometimesTapCaptured(s: Delivery): bool = s.notice.tapToken > 0
pure def stepReleaseRetainsNotice(before: Delivery, via: str, after: Delivery): bool =
  via == "releaseMailTap" implies before.notice.phase == after.notice.phase
pure def sometimesAmbiguousNotice(s: Delivery): bool = s.notice.phase == N::NoticeUnknown
pure val weight_selectGrant = 3
pure val weight_settleSelection = 5
pure val weight_acceptHistory = 8
pure val weight_withdrawGrant = 2
pure val weight_reserveMailNotice = 5
pure val weight_settleMailPost = 5
pure val weight_captureMailTap = 12
pure val weight_consumeMailTap = 10
pure val weight_releaseMailTap = 10
```

# Alpha native message review and exact cancellation

Alpha only registers `AlphaTelephonyPlugin` on its verified system
image. The plugin subclasses Eliza's pinned `TelephonyPlugin` from
`plugins/plugin-native-messages/android`. Its owner and Android role
policy remain product supplied. The source
`quint/NativeSmsReviewOwnership.qnt` models an owned journal lookup,
main queue review, recorded invocation and cancellation. This model
covers one admitted SMS or MMS review and its settlement. It treats
Android permissions, image evidence, role and destination validation
as host admission. It does not infer carrier delivery.

## Story: Review one message and cancel before native invocation

### Native confirmation and current ownership must precede dispatch

The authenticated operation captures its exact ID before its journal
lookup. A usable journal result may queue a review dialog. The visible
owner can approve that dialog once. A cancel for the exact operation
retires it before acknowledging. A background or destroyed owner also
retires it. A cancel for another ID does not affect it. Retirement
before the native dispatch settles as cancelled with no invocation.
After the platform accepts dispatch, the actual or ambiguous result
remains reportable even if the owner retires. Journal idempotency across
distinct operations is a separate native store boundary.

```quint
type ReviewPhase = NoReview | ReadingJournal | MainQueued | Reviewing | ApprovedForDispatch | NativeDispatched | ReviewSettled
type NativeMessageResult = NoMessageResult | MessageCancelled | MessageRefused | MessageSubmitted | MessageFailed | MessageUnknown
type SmsReview = {
  phase: ReviewPhase, operationId: int, retired: bool, cancelAcknowledged: bool,
  dispatched: bool, result: NativeMessageResult
}
pure val initial: SmsReview = {
  phase: NoReview, operationId: 0, retired: false, cancelAcknowledged: false,
  dispatched: false, result: NoMessageResult
}
pure def canBeginReview(s: SmsReview, operationId: int, deviceAdmitted: bool): bool =
  s.phase == NoReview and operationId > 0 and deviceAdmitted
pure def beginReview(s: SmsReview, operationId: int, deviceAdmitted: bool): SmsReview =
  {...s, phase: ReadingJournal, operationId: operationId}
pure val operationIdValues = Set(0, 1, 2)
pure def canFinishLookup(s: SmsReview): bool = s.phase == ReadingJournal
pure def finishLookup(s: SmsReview, journalAllowsReview: bool): SmsReview =
  if (s.retired) {...s, phase: ReviewSettled, result: MessageCancelled}
  else if (journalAllowsReview) {...s, phase: MainQueued}
  else {...s, phase: ReviewSettled, result: MessageRefused}
pure def canShowReview(s: SmsReview): bool = s.phase == MainQueued and not(s.retired)
pure def showReview(s: SmsReview): SmsReview = {...s, phase: Reviewing}
pure def canApproveReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def approveReview(s: SmsReview): SmsReview = {...s, phase: ApprovedForDispatch}
pure def canRejectReview(s: SmsReview): bool = s.phase == Reviewing and not(s.retired)
pure def rejectReview(s: SmsReview): SmsReview = {...s, phase: ReviewSettled, result: MessageCancelled}
pure def pendingReview(s: SmsReview): bool = s.phase != NoReview and s.phase != ReviewSettled
pure def canCancelReview(s: SmsReview, operationId: int): bool = pendingReview(s) and operationId == s.operationId and not(s.cancelAcknowledged)
pure def cancelReview(s: SmsReview, operationId: int): SmsReview = {...s, retired: true, cancelAcknowledged: true}
pure def canRetireReview(s: SmsReview): bool = pendingReview(s) and not(s.retired)
pure def retireReview(s: SmsReview): SmsReview = {...s, retired: true}
pure def canSettleRetiredReview(s: SmsReview): bool =
  s.retired and (s.phase == MainQueued or s.phase == Reviewing or s.phase == ApprovedForDispatch)
pure def settleRetiredReview(s: SmsReview): SmsReview = {...s, phase: ReviewSettled, result: MessageCancelled}
pure def canDispatchApproved(s: SmsReview): bool =
  s.phase == ApprovedForDispatch and not(s.retired) and not(s.dispatched)
pure def dispatchApproved(s: SmsReview): SmsReview = {...s, phase: NativeDispatched, dispatched: true}
pure def canReportDispatch(s: SmsReview, receipt: NativeMessageResult): bool =
  s.phase == NativeDispatched and (receipt == MessageSubmitted or receipt == MessageFailed or receipt == MessageUnknown)
pure def reportDispatch(s: SmsReview, receipt: NativeMessageResult): SmsReview =
  {...s, phase: ReviewSettled, result: receipt}
pure def alwaysCancellationOwnsRetirement(s: SmsReview): bool = s.cancelAcknowledged implies s.retired
pure def alwaysDispatchHasOwnedPhase(s: SmsReview): bool =
  s.dispatched == (s.phase == NativeDispatched or s.result == MessageSubmitted or s.result == MessageFailed or s.result == MessageUnknown)
pure def alwaysTerminalResultIsExplicit(s: SmsReview): bool = (s.phase == ReviewSettled) == (s.result != NoMessageResult)
pure def stepCancelledCannotInvoke(before: SmsReview, after: SmsReview): bool =
  before.cancelAcknowledged implies after.dispatched == before.dispatched
pure def stepKnownResultPersists(before: SmsReview, after: SmsReview): bool =
  before.result != NoMessageResult implies after.result == before.result
pure def sometimesCancelledBeforeInvoke(s: SmsReview): bool = s.result == MessageCancelled and s.cancelAcknowledged
pure def sometimesResultSurvivesRetirement(s: SmsReview): bool = s.result == MessageSubmitted and s.retired
```

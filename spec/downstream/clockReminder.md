# AlphaPhone Clock handoff and reminder journal

AlphaPhone's renderer projects `clock-contract.ts`, `clock-handoff.ts`,
`clock-handoff-history.ts`, `clock-review-executor.ts`,
`reminder-contract.ts`, `reminder-create-contract.ts`, and
`reminder-journal.ts` from `plugins/plugin-assistant/src/services/device-actions/`
at Eliza `c518127a025ab173874af9c7d304f26b25213b0d`. The host owns native
effects, exact approval identity, receipt validation, and scheduling. The
renderer owns custody of its durable request and refuses mismatched host
evidence before presenting a result.

## Story: Open Clock with the capability and consent I reviewed

### A newer operation cannot use an older capability

A clock alarm record requires the alarm capability. A handoff set
operation with its own days field requires repeat support, including an
explicit empty repeat list. Ordinary handoff accepts either version. A
reminder whose target or requested timing needs version two also requires
version two. Reminder creation has its own capability. Bound native
decoders check discriminants, exact keys, timezone support, weekday
range and uniqueness, date and text size, target revision, and IDs before
applying these routing rules.

```quint
type ClockRequest = ClockAlarmRecord | ClockHandoffSetWithDays | ClockOrdinaryHandoff
pure def admitsClock(operation: ClockRequest, handoff: bool, repeat: bool, alarm: bool): bool =
  if (operation == ClockAlarmRecord) alarm else if (operation == ClockHandoffSetWithDays) repeat else handoff or repeat
pure def admitsReminder(targetV2: bool, timingIncluded: bool, v1: bool, v2: bool): bool =
  v2 or (not(targetV2 or timingIncluded) and v1)
pure def lawRepeatRequiresRepeatCapability(handoff: bool, alarm: bool): bool =
  not(admitsClock(ClockHandoffSetWithDays, handoff, false, alarm))
pure def lawTimingCannotDowngrade(targetV2: bool, timingIncluded: bool): bool =
  (targetV2 or timingIncluded) implies not(admitsReminder(targetV2, timingIncluded, true, false))
```

### Clock history is saved against the exact legacy source and prior envelope

A missing native envelope reads the legacy record. An existing envelope
requires exact preserved legacy input before publishing its record.
Saving checks the expected legacy input, compare-exchanges the prior
envelope, and exposes success only after reading the same new envelope.
The model treats record and envelope keys as decoded canonical identities.
A storage error reports explicitly even when a write might have landed.

```quint
type HistoryAdmission = HistoryMissing | HistoryAvailable | HistoryUnreadable | HistoryLegacyChanged
pure def clockHistory(hasEnvelope: bool, readable: bool, exactLegacy: bool, hasLegacy: bool): HistoryAdmission =
  if (not(readable)) HistoryUnreadable
  else if (hasEnvelope and not(exactLegacy)) HistoryLegacyChanged
  else if (hasEnvelope or hasLegacy) HistoryAvailable else HistoryMissing
pure def clockHistorySaved(expectedLegacy: bool, compareSaved: bool, readbackExact: bool): bool =
  expectedLegacy and compareSaved and readbackExact
pure def lawClockReadbackRequired(expectedLegacy: bool, compareSaved: bool): bool =
  not(clockHistorySaved(expectedLegacy, compareSaved, false))
```

### A reviewed operation settles or remains registered for native cancellation

The model projects one review invocation. The prepared owner must
remain live at the reviewed response and token dispatch. An immediate
result follows the same result decoder as the confirmed response.
A token passes only after length and shape admission. A live call enters
cleanup on return, failure, or abort. The host cannot retire the executor
until every cancellation acknowledges. A failed cancellation stays
registered. Explicit retirement can retry cancellation for that same
scope, proposal, and operation ID. Result publication waits for final
cleanup. Clock UI launch is not verification that an external alarm was set.

```quint
type ClockPhase = ClockIdle | ClockReviewing | ClockConfirming | ClockCancelling | ClockCancelFailed | ClockRetired
type ClockReview = { phase: ClockPhase, nativeSent: bool, acceptedOutcome: bool, published: bool }
pure val initial: ClockReview = { phase: ClockIdle, nativeSent: false, acceptedOutcome: false, published: false }
pure def canBeginClock(c: ClockReview): bool = c.phase == ClockIdle
pure def beginClock(c: ClockReview): ClockReview = { ...c, phase: ClockReviewing }
pure def canConfirmClock(c: ClockReview, validToken: bool, currentOwner: bool): bool = c.phase == ClockReviewing and validToken and currentOwner
pure def confirmClock(c: ClockReview, validToken: bool, currentOwner: bool): ClockReview = { ...c, phase: ClockConfirming, nativeSent: true }
pure def canFinishClock(c: ClockReview): bool = c.phase == ClockReviewing or c.phase == ClockConfirming
pure def finishClock(c: ClockReview, exactOutcome: bool, stillOwned: bool): ClockReview =
  { ...c, phase: ClockCancelling, acceptedOutcome: exactOutcome and stillOwned }
pure def canCancelClock(c: ClockReview): bool = c.phase == ClockReviewing or c.phase == ClockConfirming
pure def cancelClock(c: ClockReview): ClockReview = { ...c, phase: ClockCancelling }
pure def canObserveClockCancellation(c: ClockReview): bool = c.phase == ClockCancelling
pure def observeClockCancellation(c: ClockReview, acknowledged: bool): ClockReview =
  { ...c, phase: if (acknowledged) ClockRetired else ClockCancelFailed, published: acknowledged and c.acceptedOutcome }
pure def canRetryClockCancellation(c: ClockReview): bool = c.phase == ClockCancelFailed
pure def retryClockCancellation(c: ClockReview): ClockReview = { ...c, phase: ClockCancelling, acceptedOutcome: false }
pure def alwaysClockPublicationAcknowledged(c: ClockReview): bool = c.published implies c.acceptedOutcome and c.phase == ClockRetired
pure def alwaysClockConfirmationWasSent(c: ClockReview): bool = c.phase == ClockConfirming implies c.nativeSent
pure def stepClockConfirmationIsOneUse(before: ClockReview, via: str, after: ClockReview): bool = via == "confirmClock" implies not(before.nativeSent)
pure def alwaysClockReviewStartsUnsent(c: ClockReview): bool = (c.phase == ClockIdle or c.phase == ClockReviewing) implies not(c.nativeSent)
pure def sometimesClockConfirmationPublished(c: ClockReview): bool = c.phase == ClockRetired and c.nativeSent and c.published
pure def sometimesClockCleanupStaysRegistered(c: ClockReview): bool = c.phase == ClockCancelFailed
```

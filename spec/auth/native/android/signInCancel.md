# Android sign-in cancel

The renderer's sign-in controller gives each dispatched operation a request
id and cancels exactly that request, while Android keeps one native sign-in
slot. The same scoped receipt fences a cancel after a code resend, in
[sign-in resend](./signInResend.md). The native screens and their code
worker are [Android sign-in](./signIn.md).

## Story: Cancel exactly the sign-in I am leaving

> As a person who leaves or restarts sign-in, I want only my own attempt
> cancelled, never a newer one that another screen already started.

### A scoped cancel retires only its own request, and a stale one changes nothing

The controller gives each dispatched operation a request id; the Android
port refuses a new one while another request owns its slot. A cancel
names the request it captured. Its acknowledgement clears the native slot
only when the slot still holds that request; a late cancel for an older
request leaves a newer one alone. A failed cancel is retried before the
next dispatch. Disposing the controller shares the cancellation in flight
and does not wait for it, and work that was only queued owns no native
attempt. With no cancel pending or failed, the controller remembers no
cancel at all, and while a cancel is pending it shows no native screen.

```quint
type CtlPhase = ShowingMethods | QueuedMethod | NativeMethod
type CleanupState = NoCleanup | CleanupWaiting | CleanupFailed
type CleanupIntent = NoIntent | ChooseIntent | LeaveIntent | AbortIntent | DispatchIntent
type Cleanup = { request: int, cleanupState: CleanupState, intent: CleanupIntent }
type ScopedReceipt = { request: int, before: int, after: int }
type SignInCancel = { mounted: bool, issued: int, request: int, phase: CtlPhase, native: int, cleanup: Cleanup, detached: Set[int], receipt: ScopedReceipt }
pure val noCleanup: Cleanup = { request: 0, cleanupState: NoCleanup, intent: NoIntent }
pure val noReceipt: ScopedReceipt = { request: 0, before: 0, after: 0 }
pure val initial: SignInCancel = { mounted: true, issued: 0, request: 0, phase: ShowingMethods, native: 0, cleanup: noCleanup, detached: Set(), receipt: noReceipt }
pure def scopeCancel(native: int, req: int): int = if (native == req) 0 else native
pure def cancelReceipt(native: int, req: int): ScopedReceipt = { request: req, before: native, after: scopeCancel(native, req) }
pure def receiptScoped(r: ScopedReceipt): bool = if (r.request == 0) r == noReceipt else r.after == scopeCancel(r.before, r.request)
pure def canReopen(c: SignInCancel): bool = not(c.mounted)
pure def reopen(c: SignInCancel): SignInCancel = { ...c, mounted: true, phase: ShowingMethods }
pure def canQueueMethod(c: SignInCancel): bool =
  c.mounted and c.phase == ShowingMethods and c.cleanup.cleanupState != CleanupWaiting and (c.request == 0 or c.cleanup.cleanupState == CleanupFailed)
pure def queueMethod(c: SignInCancel): SignInCancel =
  { ...c, phase: QueuedMethod, cleanup: if (c.cleanup.cleanupState == CleanupFailed) { ...c.cleanup, cleanupState: CleanupWaiting, intent: DispatchIntent } else noCleanup }
pure def canAdmitMethod(c: SignInCancel): bool = c.mounted and c.phase == QueuedMethod and c.request == 0 and c.cleanup == noCleanup
pure def admitMethod(c: SignInCancel): SignInCancel =
  { ...c, issued: c.issued + 1, request: c.issued + 1, phase: if (c.native == 0) NativeMethod else ShowingMethods, native: if (c.native == 0) c.issued + 1 else c.native }
pure def canRejectAdmission(c: SignInCancel): bool = canAdmitMethod(c)
pure def rejectAdmission(c: SignInCancel): SignInCancel = { ...c, phase: ShowingMethods }
pure def canNativeReply(c: SignInCancel): bool = c.phase == NativeMethod and c.cleanup == noCleanup
pure def nativeReply(c: SignInCancel): SignInCancel = { ...c, phase: ShowingMethods }
pure def canNativeEnds(c: SignInCancel): bool = c.native != 0
pure def nativeEnds(c: SignInCancel): SignInCancel = { ...c, native: 0 }
pure def canBeginCleanup(c: SignInCancel, intent: CleanupIntent): bool =
  c.mounted and c.cleanup.cleanupState != CleanupWaiting and intent != NoIntent and intent != DispatchIntent and
    (intent != AbortIntent or c.phase == QueuedMethod or c.phase == NativeMethod)
pure def beginCleanup(c: SignInCancel, intent: CleanupIntent): SignInCancel =
  if (c.request == 0) { ...c, mounted: intent != LeaveIntent, phase: ShowingMethods }
  else { ...c, phase: ShowingMethods, cleanup: { request: c.request, cleanupState: CleanupWaiting, intent: intent } }
pure def canCleanupReply(c: SignInCancel, req: int, acknowledged: bool): bool = c.cleanup.cleanupState == CleanupWaiting and c.cleanup.request == req
pure def cleanupReply(c: SignInCancel, req: int, acknowledged: bool): SignInCancel =
  if (acknowledged) { ...c, request: 0, native: scopeCancel(c.native, req), receipt: cancelReceipt(c.native, req), mounted: c.cleanup.intent != LeaveIntent, cleanup: noCleanup }
  else { ...c, phase: ShowingMethods, cleanup: { ...c.cleanup, cleanupState: CleanupFailed } }
pure def canDispose(c: SignInCancel): bool = c.mounted
pure def dispose(c: SignInCancel): SignInCancel =
  { ...c, mounted: false, request: 0, phase: ShowingMethods, cleanup: noCleanup, detached: if (c.request == 0) c.detached else c.detached.union(Set(c.request)) }
pure def canDetachedReply(c: SignInCancel, req: int, acknowledged: bool): bool = c.detached.contains(req)
pure def detachedReply(c: SignInCancel, req: int, acknowledged: bool): SignInCancel =
  { ...c, detached: c.detached.exclude(Set(req)), native: if (acknowledged) scopeCancel(c.native, req) else c.native,
    receipt: if (acknowledged) cancelReceipt(c.native, req) else c.receipt }
pure val reqValues = Set(1, 2, 3)
pure def alwaysDispatchOwnsRequest(c: SignInCancel): bool =
  c.request >= 0 and c.request <= c.issued and c.native >= 0 and c.native <= c.issued and c.detached.forall(d => d >= 1 and d <= c.issued) and
    (not(c.mounted) implies (c.request == 0 and c.cleanup == noCleanup)) and (c.phase == NativeMethod implies c.request != 0) and
    not(c.detached.contains(c.request))
pure def alwaysCancellationKeepsItsFence(c: SignInCancel): bool =
  (c.cleanup.cleanupState != NoCleanup implies (c.mounted and c.cleanup.request != 0 and c.cleanup.request == c.request)) and
    ((c.phase == QueuedMethod and c.request != 0) implies (c.cleanup.cleanupState == CleanupWaiting and c.cleanup.intent == DispatchIntent)) and
    (c.cleanup.cleanupState == CleanupFailed implies c.phase == ShowingMethods)
pure def alwaysNoCleanupRemembersNothing(c: SignInCancel): bool = c.cleanup.cleanupState == NoCleanup implies c.cleanup == noCleanup
pure def alwaysPendingCancelShowsNoNativeScreen(c: SignInCancel): bool = c.cleanup.cleanupState == CleanupWaiting implies c.phase != NativeMethod
pure def alwaysScopedReceiptPreservesForeignAttempt(c: SignInCancel): bool = receiptScoped(c.receipt)
pure def sometimesLateCancelSparedNewerRequest(c: SignInCancel): bool = c.receipt.request != 0 and c.receipt.before != c.receipt.request and c.receipt.after != 0
pure def sometimesFailedCancelRetried(c: SignInCancel): bool = c.cleanup.intent == DispatchIntent
```

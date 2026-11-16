# Device actions

The agent proposes actions that run on the user's device: calendar, SMS,
phone, contacts, photos, notes, files, camera, reminders and the clock. This
spec owns one device request on the server: its approval, its single
delivery to the device, and how its outcome is classified. The generic
approval list has no device authority and never shows these records. The
device side:

- [Capability vocabulary and negotiation](./capabilities.md)
- [Device action custody](./execution.md): journal, claim, executor call
  and receipt
- [Device effect authority and SMS bounds](./telephonyReview.md)
- [Original read completion](./readCompletion.md)
- [Camera](./camera.md), [Photos](./photos.md) and
  [Clock and reminders](./clock.md)

## Story: Approve a device request once and learn exactly what happened

> As a user, I approve a device action before its deadline and the device
> receives it once. If I reject it or the deadline passes it never runs. If
> the device's answer is lost, the request says the outcome is uncertain until
> a confirmed review settles it, and nothing ever runs it a second time.

### Only the exact binding decides a pending request before its deadline

A decision must carry the exact device binding: the right installation and
the digest of the reviewed proposal. A pending request is approved or
rejected before its deadline; repeating the same decision is accepted and
changes nothing. A pending request whose deadline passes is purged as expired.

```quint
type Binding = Exact | Foreign | WrongDigest
type RequestPhase = RequestPending | RequestApproved | RequestRejected | RequestExpired | RequestDispatched | RequestUncertain | AppliedByReceipt | AppliedByReview | ConfirmedNotApplied
type DeviceRequest = { phase: RequestPhase, deadlineReached: bool, claims: int, enrolled: bool, turnLive: bool }
pure val initial: DeviceRequest = { phase: RequestPending, deadlineReached: false, claims: 0, enrolled: true, turnLive: true }
pure def decisionTarget(approved: bool): RequestPhase = if (approved) RequestApproved else RequestRejected
pure def canDecide(d: DeviceRequest, binding: Binding, approved: bool): bool =
  binding == Exact and (d.phase == decisionTarget(approved) or (d.phase == RequestPending and not(d.deadlineReached)))
pure def decide(d: DeviceRequest, binding: Binding, approved: bool): DeviceRequest = { ...d, phase: decisionTarget(approved) }
pure def canReachDeadline(d: DeviceRequest): bool = not(d.deadlineReached)
pure def reachDeadline(d: DeviceRequest): DeviceRequest = { ...d, deadlineReached: true }
pure def canPurgePending(d: DeviceRequest): bool = d.phase == RequestPending and d.deadlineReached
pure def purgePending(d: DeviceRequest): DeviceRequest = { ...d, phase: RequestExpired }
pure def sometimesExpiredUnclaimed(d: DeviceRequest): bool = d.phase == RequestExpired and d.claims == 0
```

### One claim by the enrolled device in the live turn commits the dispatch

The device claims an approved request with the exact binding before the
deadline, while its enrollment and the conversation turn that offered the
request are both live. The claim and the dispatch mark are one transaction, so
a lost reply to the claim cannot lead to a second delivery: the request is
already dispatched. Revoking the enrollment or ending the turn before the
claim keeps the request from ever reaching the device.

```quint
pure def canClaim(d: DeviceRequest, binding: Binding): bool =
  binding == Exact and d.phase == RequestApproved and not(d.deadlineReached) and d.enrolled and d.turnLive
pure def claim(d: DeviceRequest, binding: Binding): DeviceRequest = { ...d, phase: RequestDispatched, claims: d.claims + 1 }
pure def canRevokeEnrollment(d: DeviceRequest): bool = d.enrolled
pure def revokeEnrollment(d: DeviceRequest): DeviceRequest = { ...d, enrolled: false }
pure def canEndTurn(d: DeviceRequest): bool = d.turnLive
pure def endTurn(d: DeviceRequest): DeviceRequest = { ...d, turnLive: false }
pure def alwaysAtMostOneClaim(d: DeviceRequest): bool = d.claims == 0 or d.claims == 1
pure def stepClaimCommitsDispatch(before: DeviceRequest, after: DeviceRequest): bool =
  after.claims > before.claims implies
    (before.phase == RequestApproved and not(before.deadlineReached) and before.enrolled and before.turnLive and after.phase == RequestDispatched)
pure def sometimesRevokedBeforeDelivery(d: DeviceRequest): bool = not(d.enrolled) and d.phase == RequestApproved and d.claims == 0
```

### A dispatched request is classified only from the exact device's receipt, or becomes uncertain

A receipt must carry the exact binding and the attempt the claim granted. It
settles the request as applied, or as uncertain when the device cannot say the
effect happened. A dispatched request whose deadline passes without a receipt
is uncertain too: the device may have acted. Only a confirmed review of the
exact attempt settles an uncertain request, as applied or as confirmed not
applied. Every outcome follows exactly one claim.

```quint
pure def canReceipt(d: DeviceRequest, binding: Binding, attemptMatches: bool, applied: bool): bool =
  binding == Exact and attemptMatches and d.phase == RequestDispatched
pure def receipt(d: DeviceRequest, binding: Binding, attemptMatches: bool, applied: bool): DeviceRequest =
  { ...d, phase: if (applied) AppliedByReceipt else RequestUncertain }
pure def canTimeOutDispatch(d: DeviceRequest): bool = d.phase == RequestDispatched and d.deadlineReached
pure def timeOutDispatch(d: DeviceRequest): DeviceRequest = { ...d, phase: RequestUncertain }
pure def canReconcile(d: DeviceRequest, binding: Binding, attemptMatches: bool, confirmed: bool, applied: bool): bool =
  binding == Exact and attemptMatches and confirmed and d.phase == RequestUncertain
pure def reconcile(d: DeviceRequest, binding: Binding, attemptMatches: bool, confirmed: bool, applied: bool): DeviceRequest =
  { ...d, phase: if (applied) AppliedByReview else ConfirmedNotApplied }
pure def afterDispatch(phase: RequestPhase): bool =
  phase == RequestDispatched or phase == RequestUncertain or phase == AppliedByReceipt or phase == AppliedByReview or phase == ConfirmedNotApplied
pure def alwaysOutcomeFollowsOneClaim(d: DeviceRequest): bool = afterDispatch(d.phase) implies d.claims == 1
pure val fair_receipt = "weak"
pure def leadsToDispatchClassified(d: DeviceRequest, later: DeviceRequest): bool =
  d.phase == RequestDispatched implies later.phase != RequestDispatched
pure def sometimesAppliedByReceipt(d: DeviceRequest): bool = d.phase == AppliedByReceipt
pure def sometimesConfirmedNotApplied(d: DeviceRequest): bool = d.phase == ConfirmedNotApplied
```

### A settled request never changes again

Rejected, expired and applied requests, and requests confirmed not applied,
are terminal: no later event changes their phase or claim count.

```quint
pure def terminalPhase(phase: RequestPhase): bool =
  phase == RequestRejected or phase == RequestExpired or phase == AppliedByReceipt or phase == AppliedByReview or phase == ConfirmedNotApplied
pure def stepTerminalRequestIsStable(before: DeviceRequest, after: DeviceRequest): bool =
  terminalPhase(before.phase) implies (after.phase == before.phase and after.claims == before.claims)
```

# Page commands

The page command peer runs beside the page in the host WebView and in the
owned Chromium (`browser/src/surface-task-handler.mjs`, `task-bindings.mjs`,
`page-command.mjs`). The agent's surface channel delivers a copied command
to it; the agent's task host owns the task, its consent and the decision
whether a step is done. This spec owns what the peer admits, the binding
that scopes it, the page observation it acts on, and what it reports. The
report uses the task's own operation states of
[interactive task](../../core/interactiveTask.md): a page read that came
back whole is `Succeeded`, an input the page confirmed is only `Dispatched`
until the task host reads the page back, and anything the peer cannot
confirm is `Unknown`. The shell parses messages, reads the clock, the
selected page and its origin, and passes the facts below.

## Story: Run a website task step only on the page it was planned for

> As a person letting the agent work on a website, I want each step to act
> only on the page and task I approved, and never twice, so that a stale,
> forged or repeated command never touches the site.

### The peer takes only the fixed page commands, and a request needs a live binding and its scope

A page command is a snapshot, click, fill, select, scroll or follow, with
its request identity, the page it names and its task context. The shell
maps anything else, a protected-value fill and a caller-supplied page
policy to an unlisted action, which is refused by policy and spends
nothing. Admission also needs a live binding for the page and its scope:
the exact task context, a deadline (the earlier of the command's and the
binding's) still ahead, an allowed origin for the page and a reviewed
target when the command names one. Commands run one at a time.

```quint
import address.* from "./address"
import interactiveTask as T from "../../core/interactiveTask"
type RequestedAction = SnapshotAction | ClickAction | FillAction | SelectAction | ScrollAction | FollowAction | UnlistedAction
type PageRequest = { requestId: str, pageAction: RequestedAction, selectorRef: str }
type BindingStatus = Unbound | Replacing | Revoking | Live | Revoked
type Binding = { status: BindingStatus, revision: int, taskId: str, epoch: int }
type Observation = Unobserved | Observed({ snapshotRef: str, revision: int })
type ReceiverPhase = ReceiverIdle | ReceiverReading | ReceiverChecking | ReceiverSending
type Refusal = RefusedPolicy | RefusedStale | RefusedIncomplete
type Reply = NoReply | Refused({ refusal: Refusal }) | Reported({ status: T::OperationStatus, evidenceRef: str }) | TargetChecked
type SurfaceReceiver = { retired: bool, binding: Binding, observation: Observation, phase: ReceiverPhase, request: PageRequest, admittedRevision: int, spent: List[str], reply: Reply }
pure val initial: SurfaceReceiver = { retired: false, binding: { status: Unbound, revision: 0, taskId: "", epoch: 0 }, observation: Unobserved,
  phase: ReceiverIdle, request: { requestId: "", pageAction: UnlistedAction, selectorRef: "" }, admittedRevision: 0, spent: List(), reply: NoReply }
pure def isObserved(o: Observation): bool = match o { | Observed(x) => true | _ => false }
pure def observedRevision(o: Observation): int = match o { | Observed(x) => x.revision | _ => -1 }
pure def observedAs(o: Observation, selectorRef: str): bool = match o { | Observed(x) => x.snapshotRef == selectorRef | _ => false }
pure def reportsStatus(r: Reply, status: T::OperationStatus): bool = match r { | Reported(x) => x.status == status | _ => false }
pure def refusedWith(r: Reply, refusal: Refusal): bool = match r { | Refused(x) => x.refusal == refusal | _ => false }
pure def holdsLiveRevision(s: SurfaceReceiver): bool = s.binding.status == Live and s.binding.revision == s.admittedRevision
pure def canAdmitRequest(s: SurfaceReceiver, message: PageRequest, inScope: bool): bool = not(s.retired) and s.phase == ReceiverIdle and message.requestId != ""
pure def admitRequest(s: SurfaceReceiver, message: PageRequest, inScope: bool): SurfaceReceiver = {
  val refused = { ...s, request: message }
  if (message.pageAction == UnlistedAction) { ...refused, reply: Refused({ refusal: RefusedPolicy }) }
  else if (s.spent.includes(message.requestId)) { ...refused, reply: Reported({ status: T::Unknown, evidenceRef: "" }) }
  else if (not(s.binding.status == Live and inScope)) { ...refused, reply: Refused({ refusal: RefusedPolicy }) }
  else if (message.pageAction == SnapshotAction)
    { ...s, request: message, admittedRevision: s.binding.revision, spent: s.spent.append(message.requestId), reply: NoReply, phase: ReceiverReading, observation: Unobserved }
  else { ...s, request: message, admittedRevision: s.binding.revision, spent: s.spent.append(message.requestId), reply: NoReply, phase: ReceiverChecking }
}
pure val messageValues: Set[PageRequest] = Set(
  { requestId: "r1", pageAction: SnapshotAction, selectorRef: "" },
  { requestId: "r2", pageAction: ClickAction, selectorRef: "snap1" },
  { requestId: "r3", pageAction: FillAction, selectorRef: "snap2" },
  { requestId: "r1", pageAction: ClickAction, selectorRef: "snap1" },
  { requestId: "r4", pageAction: UnlistedAction, selectorRef: "" },
  { requestId: "r5", pageAction: SnapshotAction, selectorRef: "" })
pure def sometimesPolicyRefused(s: SurfaceReceiver): bool = refusedWith(s.reply, RefusedPolicy) and s.spent == List()
```

### A binding is replaced only by a newer revision, and a task's epoch never goes back

Task bindings run on their own queue, so a replacement can arrive while a
command is in flight. A replacement needs a greater binding revision, even
for another task. For the same task a lower epoch is refused, and the same
epoch is allowed only to renew an expired live binding with an identical
context; a revoked binding needs a new epoch. The shell says whether the
offer renews (`renewsExpired`).

```quint
type BindingOffer = { revision: int, taskId: str, epoch: int, revoke: bool, renewsExpired: bool }
pure def fencing(b: Binding): bool = b.status == Replacing or b.status == Revoking
pure def canBindTask(s: SurfaceReceiver, offer: BindingOffer): bool =
  not(s.retired) and not(fencing(s.binding)) and offer.taskId != "" and offer.epoch >= 0 and offer.revision > s.binding.revision and
    (s.binding.status == Unbound or offer.taskId != s.binding.taskId or offer.epoch > s.binding.epoch or
     (offer.epoch == s.binding.epoch and s.binding.status == Live and not(offer.revoke) and offer.renewsExpired))
pure def bindTask(s: SurfaceReceiver, offer: BindingOffer): SurfaceReceiver =
  { ...s, observation: Unobserved, binding: { status: if (offer.revoke) Revoking else Replacing, revision: offer.revision, taskId: offer.taskId, epoch: offer.epoch } }
pure val offerValues: Set[BindingOffer] = Set(
  { revision: 1, taskId: "task1", epoch: 1, revoke: false, renewsExpired: false },
  { revision: 2, taskId: "task1", epoch: 1, revoke: false, renewsExpired: true },
  { revision: 2, taskId: "task1", epoch: 2, revoke: true, renewsExpired: false },
  { revision: 3, taskId: "task1", epoch: 0, revoke: false, renewsExpired: false },
  { revision: 3, taskId: "task2", epoch: 0, revoke: false, renewsExpired: false })
pure def stepBindingRevisionNeverGoesBack(before: SurfaceReceiver, after: SurfaceReceiver): bool = after.binding.revision >= before.binding.revision
```

### Replacing a binding fences the old page before cleanup and never revives a revoked binding

The replacement is installed revoked and the page's observation dropped
before the shell awaits guidance cleanup and storage. It goes live only if
it is not a revocation, was persisted, and the peer is still current;
otherwise it stays revoked, and the older binding is never restored.

```quint
pure def canSettleBinding(s: SurfaceReceiver): bool = fencing(s.binding)
pure def settleBinding(s: SurfaceReceiver, persisted: bool): SurfaceReceiver =
  { ...s, binding: { ...s.binding, status: if (s.binding.status == Replacing and persisted) Live else Revoked } }
pure def stepBindingFencesAtOnce(before: SurfaceReceiver, via: str, after: SurfaceReceiver): bool =
  via == "bindTask" implies (fencing(after.binding) and not(isObserved(after.observation)))
pure def stepRevokedBindingNeverRevives(before: SurfaceReceiver, after: SurfaceReceiver): bool =
  before.binding.status == Revoked implies not(after.binding.status == Live and after.binding.revision == before.binding.revision)
pure def sometimesReplacedDuringInput(s: SurfaceReceiver): bool = s.phase == ReceiverSending and fencing(s.binding)
pure def sometimesRevoked(s: SurfaceReceiver): bool = s.binding.status == Revoked and not(s.retired)
pure val weight_settleBinding = 4
```

### An observation belongs to the live binding it was read under, and a read or an input holds none

A snapshot drops the page's old observation before the native read, and
keeps the new one only while the same binding is live and native returned
a complete main-frame result for the scoped origin; each node is then
named by snapshot, main frame and node. Dispatching an input consumes the
observation, so the next input needs a new read.

```quint
pure def canSettleRead(s: SurfaceReceiver): bool = s.phase == ReceiverReading
pure def settleRead(s: SurfaceReceiver, snapshotRef: str, wholeFrame: bool): SurfaceReceiver =
  if (not(holdsLiveRevision(s))) { ...s, phase: ReceiverIdle, reply: Refused({ refusal: RefusedStale }) }
  else if (not(wholeFrame) or snapshotRef == "") { ...s, phase: ReceiverIdle, reply: Refused({ refusal: RefusedIncomplete }) }
  else { ...s, phase: ReceiverIdle, observation: Observed({ snapshotRef: snapshotRef, revision: s.binding.revision }),
    reply: Reported({ status: T::Succeeded, evidenceRef: snapshotRef }) }
pure val snapshotRefValues = Set("snap1", "snap2", "")
pure def alwaysObservationBelongsToLiveBinding(s: SurfaceReceiver): bool =
  isObserved(s.observation) implies (s.binding.status == Live and observedRevision(s.observation) == s.binding.revision)
pure def alwaysReadOrInputHoldsNoObservation(s: SurfaceReceiver): bool =
  (s.phase == ReceiverReading or s.phase == ReceiverSending) implies not(isObserved(s.observation))
pure def sometimesSnapshotObserved(s: SurfaceReceiver): bool = isObserved(s.observation)
pure val weight_admitRequest = 6
pure val weight_settleRead = 6
```

### The selector is checked only after the request identity is spent

From admission on the identity is spent, whatever happens next; a failure
before admission leaves it free. An input then needs the observation its
selector names, a ready guidance preview for the same action, and the same
live binding, checked again before dispatch; a stale selector is refused
and still spends the identity.

```quint
pure def canDispatchInput(s: SurfaceReceiver): bool = s.phase == ReceiverChecking
pure def dispatchInput(s: SurfaceReceiver, previewReady: bool): SurfaceReceiver =
  if (previewReady and holdsLiveRevision(s) and observedAs(s.observation, s.request.selectorRef)) { ...s, phase: ReceiverSending, observation: Unobserved }
  else { ...s, phase: ReceiverIdle, reply: Refused({ refusal: RefusedStale }) }
pure def alwaysRequestInFlightIsSpent(s: SurfaceReceiver): bool = s.phase != ReceiverIdle implies s.spent.includes(s.request.requestId)
pure def stepSpentRequestsAreKept(before: SurfaceReceiver, after: SurfaceReceiver): bool = before.spent.every(id => after.spent.includes(id))
pure def sometimesStaleSelectorSpent(s: SurfaceReceiver): bool =
  s.phase == ReceiverIdle and refusedWith(s.reply, RefusedStale) and s.spent.includes(s.request.requestId) and s.request.pageAction != SnapshotAction
pure val weight_dispatchInput = 6
```

### A request identity runs at most once, and a repeated one is reported unknown

The identity was spent by an earlier admission whose input may have run,
so the peer reports `Unknown` and the task host reads the page back
instead of repeating it.

```quint
pure def stepSpentRequestNeverRunsAgain(before: SurfaceReceiver, via: str, after: SurfaceReceiver): bool =
  (via == "admitRequest" and before.spent.includes(after.request.requestId) and after.request.pageAction != UnlistedAction) implies
    (after.phase == ReceiverIdle and reportsStatus(after.reply, T::Unknown))
pure def sometimesRepeatReportedUnknown(s: SurfaceReceiver): bool = reportsStatus(s.reply, T::Unknown) and s.request.requestId == "r1"
```

### An input is Dispatched only when the page confirms it, and Unknown otherwise

The input is `Dispatched` only with the same live binding, a current
guidance ticket and document, native confirming the dispatch and guidance
cleanup confirmed. With no native return, a changed binding or a failed
cleanup after input it is `Unknown`, never an error the task host could
retry.

```quint
pure def canSettleInput(s: SurfaceReceiver): bool = s.phase == ReceiverSending
pure def settleInput(s: SurfaceReceiver, confirmed: bool, cleanupOkay: bool): SurfaceReceiver = {
  val sent = holdsLiveRevision(s) and confirmed and cleanupOkay
  { ...s, phase: ReceiverIdle,
    reply: Reported({ status: if (sent) T::Dispatched else T::Unknown, evidenceRef: if (sent) s.request.selectorRef else "" }) }
}
pure def stepSettledInputIsDispatchedOrUnknown(before: SurfaceReceiver, via: str, after: SurfaceReceiver): bool =
  via == "settleInput" implies (reportsStatus(after.reply, T::Dispatched) or reportsStatus(after.reply, T::Unknown))
pure def sometimesInputDispatched(s: SurfaceReceiver): bool = reportsStatus(s.reply, T::Dispatched)
pure def sometimesInputUnknown(s: SurfaceReceiver): bool = reportsStatus(s.reply, T::Unknown) and s.request.pageAction != SnapshotAction and s.request.requestId != "r1"
pure val weight_settleInput = 6
```

### Only a read of the page is ever reported Succeeded

An input's effect is known only after the task host reads the page back,
so no other step of the peer reports `Succeeded`.

```quint
pure def stepOnlyAReadSucceeds(before: SurfaceReceiver, via: str, after: SurfaceReceiver): bool =
  (reportsStatus(after.reply, T::Succeeded) and via != "settleRead") implies after.reply == before.reply
```

### Checking a target spends nothing

A validate-only command checks its selector against the current
observation and the page's reviewed target; it dispatches no input and
spends neither the observation nor a request identity.

```quint
pure def canValidateTarget(s: SurfaceReceiver, selectorRef: str): bool = not(s.retired) and s.phase == ReceiverIdle
pure def validateTarget(s: SurfaceReceiver, selectorRef: str): SurfaceReceiver =
  { ...s, reply: if (observedAs(s.observation, selectorRef)) TargetChecked else Refused({ refusal: RefusedStale }) }
pure val selectorRefValues = Set("snap1", "snap2")
pure def stepValidationSpendsNothing(before: SurfaceReceiver, via: str, after: SurfaceReceiver): bool =
  via == "validateTarget" implies (after.spent == before.spent and after.observation == before.observation and after.phase == before.phase)
pure def sometimesTargetChecked(s: SurfaceReceiver): bool = s.reply == TargetChecked
```

### A retired peer holds no live binding and drops its observation

Closing the peer retires it, drops the observation and revokes its binding
before guidance is hidden on every page. A command still in flight then
settles as stale or `Unknown`.

```quint
pure def canRetire(s: SurfaceReceiver): bool = not(s.retired)
pure def retire(s: SurfaceReceiver): SurfaceReceiver =
  { ...s, retired: true, observation: Unobserved, binding: { ...s.binding, status: if (s.binding.status == Unbound) Unbound else Revoked } }
pure def alwaysRetiredHoldsNoLiveBinding(s: SurfaceReceiver): bool = s.retired implies (s.binding.status == Unbound or s.binding.status == Revoked)
pure def sometimesRetiredDuringInput(s: SurfaceReceiver): bool = s.retired and s.phase == ReceiverSending
```

### The current page is reported only when it is selected and at a secure web address

The current-page message reports the selected page's address, or none for
no selected page or one that is not a secure web address; a page whose
selection lease changed is stale.

```quint
type CurrentPage = NoCurrentPage | StaleCurrentPage | CurrentPageAt({ href: str })
pure def currentPageReport(selected: bool, leaseCurrent: bool, address: WebAddress): CurrentPage =
  if (not(selected)) NoCurrentPage else if (not(leaseCurrent)) StaleCurrentPage
  else if (isSecureWebAddress(address)) CurrentPageAt({ href: address.href }) else NoCurrentPage
pure def lawReportedPageIsSecure(selected: bool, leaseCurrent: bool, address: WebAddress): bool =
  currentPageReport(selected, leaseCurrent, address) != NoCurrentPage and currentPageReport(selected, leaseCurrent, address) != StaleCurrentPage
    implies (selected and leaseCurrent and isSecureWebAddress(address))
```

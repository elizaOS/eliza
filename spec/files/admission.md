# Files direct admission

A direct request to open Files, such as the agent asking to show a file,
may arrive before the Files view exists. Opening the view, getting
storage access and the owner's selection are separate steps, and the
view's own reload runs independently. A selection that arrives after
the owner left, came back, or cancelled is released rather than opened.
[View ownership](./viewOwnership.md) covers requests from a view that
is already shown.

## Story: Open the file I asked for, even from a cold start

> As the owner, I want a request to open Files to work even when Files
> was not open, and never to open a file after I cancelled or moved on.

### A direct request waits for the view, then access, then the owner's selection

A request starts by waiting for the view if Files is not active, and
for storage access if it is. Committing the view needs the owner's
confirmation and that nothing was cancelled or replaced meanwhile; it
activates the view and starts its reload. Access and then the selection
must each be granted while the request is still current: the view
active, the same view it began on, and not cancelled. Otherwise the
request is refused.

```quint
type AdmissionPhase = AdmissionIdle | AwaitingView | AwaitingAccess | Selecting | FileOpened | AdmissionRefused
type ViewLoad = Unread | Loading | Loaded | LoadFailed
type FilesAdmission = { phase: AdmissionPhase, active: bool, viewEpoch: int, actionEpoch: int, cancelled: bool,
  load: ViewLoad, selected: bool, released: bool, grantDelivered: bool }
pure val initial: FilesAdmission = { phase: AdmissionIdle, active: false, viewEpoch: 0, actionEpoch: 0, cancelled: false,
  load: Unread, selected: false, released: false, grantDelivered: false }
pure def admissionPending(s: FilesAdmission): bool = s.phase == AwaitingView or s.phase == AwaitingAccess or s.phase == Selecting
pure def requestCurrent(s: FilesAdmission): bool = s.active and s.viewEpoch == s.actionEpoch and not(s.cancelled)
pure def canBeginRequest(s: FilesAdmission): bool = s.phase == AdmissionIdle
pure def beginRequest(s: FilesAdmission): FilesAdmission =
  { ...s, phase: if (s.active) AwaitingAccess else AwaitingView, actionEpoch: s.viewEpoch }
pure def canCommitView(s: FilesAdmission): bool = s.phase == AwaitingView
pure def commitView(s: FilesAdmission, confirmed: bool): FilesAdmission =
  if (confirmed and not(s.cancelled) and s.viewEpoch == s.actionEpoch)
    { ...s, phase: AwaitingAccess, active: true, viewEpoch: s.viewEpoch + 1, actionEpoch: s.viewEpoch + 1, load: Loading }
  else { ...s, phase: AdmissionRefused }
pure def canAccessReply(s: FilesAdmission): bool = s.phase == AwaitingAccess
pure def accessReply(s: FilesAdmission, granted: bool): FilesAdmission =
  { ...s, phase: if (granted and requestCurrent(s)) Selecting else AdmissionRefused }
pure def canCancelRequest(s: FilesAdmission): bool = admissionPending(s) and not(s.cancelled)
pure def cancelRequest(s: FilesAdmission): FilesAdmission = { ...s, cancelled: true }
pure def alwaysCancelledNeverOpened(s: FilesAdmission): bool = s.cancelled implies not(s.selected)
pure def sometimesRefusedAfterCancel(s: FilesAdmission): bool = s.phase == AdmissionRefused and s.cancelled
pure val fair_commitView = "weak"
pure val fair_accessReply = "weak"
pure val fair_selectionReply = "weak"
pure def leadsToRequestSettles(s: FilesAdmission, later: FilesAdmission): bool =
  admissionPending(s) implies (later.phase == FileOpened or later.phase == AdmissionRefused)
```

### The view's reload never retires the request

Entering Files starts a new view and its reload; leaving makes it
inactive. A reload reply only records whether the list loaded; it never
changes the request's stage or which view it belongs to, so a file can
open while the list is still loading.

```quint
pure def canEnterFiles(s: FilesAdmission): bool = not(s.active)
pure def enterFiles(s: FilesAdmission): FilesAdmission = { ...s, active: true, viewEpoch: s.viewEpoch + 1, load: Loading }
pure def canLeaveFiles(s: FilesAdmission): bool = s.active
pure def leaveFiles(s: FilesAdmission): FilesAdmission = { ...s, active: false }
pure def canLoadReply(s: FilesAdmission): bool = s.active and s.load == Loading
pure def loadReply(s: FilesAdmission, success: bool): FilesAdmission = { ...s, load: if (success) Loaded else LoadFailed }
pure def stepReloadDoesNotRetireRequest(before: FilesAdmission, via: str, after: FilesAdmission): bool =
  via == "loadReply" implies after.phase == before.phase and after.actionEpoch == before.actionEpoch
pure def sometimesOpenedWhileLoading(s: FilesAdmission): bool = s.selected and s.load == Loading
```

### A granted selection opens only for the current request; a late one is released

When the owner's selection is granted while the request is current, the
file opens. A selection granted after the owner left, returned to a new
view, or cancelled is released: it never opens, and every granted
selection is either opened or released, not both.

```quint
pure def canSelectionReply(s: FilesAdmission): bool = s.phase == Selecting
pure def selectionReply(s: FilesAdmission, granted: bool): FilesAdmission =
  { ...s, phase: if (granted and requestCurrent(s)) FileOpened else AdmissionRefused,
    selected: granted and requestCurrent(s), released: granted and not(requestCurrent(s)), grantDelivered: granted }
pure def alwaysOneGrantOutcome(s: FilesAdmission): bool =
  not(s.selected and s.released) and ((s.phase == FileOpened) iff s.selected) and
  (s.grantDelivered implies (s.selected or s.released))
pure def stepRetiredGrantIsReleased(before: FilesAdmission, via: str, after: FilesAdmission): bool =
  via == "selectionReply" and not(requestCurrent(before)) implies not(after.selected) and after.released == after.grantDelivered
pure def sometimesLateGrantReleased(s: FilesAdmission): bool = s.released
pure def sometimesFileOpened(s: FilesAdmission): bool = s.phase == FileOpened
```

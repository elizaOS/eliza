# Alpha Google agent access Settings publication

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43`
mounts `GoogleConnectionsPanel` in `apps/app/src/main.tsx`.
The shipped toggles and Calendar authorization invoke
`apps/app/src/runtime/google-agent-access.ts:10–60`
from `google-connection-ui.tsx:67–71,208–215,240–268`.
The preference path is `apps/app/src/browser/device-preferences.ts:19–33`,
`preference-documents.ts:6–17` and `domain-document.ts:56–80`.
Eliza `c518127a025ab173874af9c7d304f26b25213b0d` supplies
`packages/ui/src/platform/browser-document-store.ts:174–248`.
[Native access file](./nativeGoogleAccessFile.md) owns on-device write
and operation admission. [Calendar link publication](./googleCalendarLinkPublication.md)
owns the current account, intent and link outcome. This leaf owns a
serialized renderer edit, its optional publication, and correction.

## Story: Save my Google access choice under the review I made

### An exact choice owns the lock and only the fields it edits

Both a Settings save and publication of already-saved preferences
use the same exclusive Web Lock, `alpha.google-agent-access.v1`.
If Web Locks are unavailable, the operation refuses. A second save
waits outside the first edit and its recovery. Inside the lock, the
shared document editor separately owns its per-key lock and uses
compare-and-set on the current revision and raw envelope. The pinned
store invokes the editor once. An IndexedDB conflict rejects the edit.

A guarded Calendar choice must still own its current intent when
the editor runs. It also needs the same captured legacy value, document
revision and serialized envelope, plus the same expected Calendar bit.
An ABA bit change cannot validate an older revision. Only supplied
Google fields change. The editor captures both preceding Google bits.
The model uses numbered revisions, and the port confirms exact raw and
legacy bytes. It follows two queued choices and one lock owner. An
edit refusal before commit leaves both stores. The actual edit awaits
a preference refresh after commit. If that refresh fails, the
preference write can persist while the save rejects before entering
the primary native publication or its correction.

```quint
type GoogleBits = { gmail: bool, calendar: bool }
type AccessChange = SetGmail | SetCalendar | SetBoth
type AccessChoice = { changeKind: AccessChange, nextGmail: bool, nextCalendar: bool, guarded: bool,
  expectedRevision: int, expectedCalendar: bool }
type SavePhase = SaveIdle | PrimaryPending | CorrectionPending
type SaveResult = NoSaveResult | EditRefused | SavedWithoutHost | AppliedSave | PrimaryPublicationFailed
type GoogleAccessSave = { saved: GoogleBits, hostBits: GoogleBits, previous: GoogleBits, revision: int,
  pendingChoice: bool, choice: AccessChoice, secondPending: bool, secondChoice: AccessChoice,
  owner: int, serial: int, savePhase: SavePhase,
  result: SaveResult, calls: int }
pure val fixtureBits: GoogleBits = { gmail: false, calendar: true }
pure val noAccessChoice: AccessChoice = { changeKind: SetGmail, nextGmail: false, nextCalendar: true, guarded: false,
  expectedRevision: 0, expectedCalendar: true }
pure val initial: GoogleAccessSave = { saved: fixtureBits, hostBits: fixtureBits, previous: fixtureBits,
  revision: 1, pendingChoice: false, choice: noAccessChoice, secondPending: false, secondChoice: noAccessChoice,
  owner: 0, serial: 0, savePhase: SaveIdle, result: NoSaveResult, calls: 0 }
pure def canQueueAccessChoice(s: GoogleAccessSave): bool = not(s.secondPending)
pure def queueAccessChoice(s: GoogleAccessSave, changeKind: AccessChange, nextGmail: bool, nextCalendar: bool, guarded: bool): GoogleAccessSave = {
  val queued: AccessChoice = { changeKind: changeKind, nextGmail: nextGmail, nextCalendar: nextCalendar,
    guarded: guarded, expectedRevision: if (guarded) s.revision else 0, expectedCalendar: s.saved.calendar }
  if (s.pendingChoice) { ...s, secondPending: true, secondChoice: queued }
  else { ...s, pendingChoice: true, choice: queued }
}
pure def applyAccessChoice(bits: GoogleBits, choice: AccessChoice): GoogleBits =
  { gmail: if (choice.changeKind == SetCalendar) bits.gmail else choice.nextGmail,
    calendar: if (choice.changeKind == SetGmail) bits.calendar else choice.nextCalendar }
pure def exactAccessChoice(s: GoogleAccessSave, ownerCurrent: bool, documentExact: bool): bool =
  not(s.choice.guarded) or (ownerCurrent and documentExact and s.choice.expectedRevision == s.revision and
    s.choice.expectedCalendar == s.saved.calendar)
type EditEvidence = { ownerCurrent: bool, documentExact: bool, landed: bool, refreshed: bool, hostCall: bool }
pure val ordinaryAccessEdit: EditEvidence = { ownerCurrent: true, documentExact: true, landed: true, refreshed: true, hostCall: true }
pure val editEvidenceValues = Set(ordinaryAccessEdit, { ...ordinaryAccessEdit, ownerCurrent: false },
  { ...ordinaryAccessEdit, documentExact: false }, { ...ordinaryAccessEdit, landed: false },
  { ...ordinaryAccessEdit, refreshed: false }, { ...ordinaryAccessEdit, hostCall: false })
pure def canAcquireAccessChoice(s: GoogleAccessSave): bool = s.pendingChoice and s.savePhase == SaveIdle
pure def acquireAccessChoice(s: GoogleAccessSave, editEvidence: EditEvidence): GoogleAccessSave = {
  val acquired: GoogleAccessSave = { ...s, pendingChoice: s.secondPending, choice: s.secondChoice,
    secondPending: false, secondChoice: noAccessChoice, serial: s.serial + 1 }
  val edited: GoogleAccessSave = { ...acquired, previous: s.saved, saved: applyAccessChoice(s.saved, s.choice), revision: s.revision + 1 }
  if (not(exactAccessChoice(s, editEvidence.ownerCurrent, editEvidence.documentExact) and editEvidence.landed))
    { ...acquired, result: EditRefused }
  else if (not(editEvidence.refreshed)) { ...edited, result: EditRefused }
  else if (not(editEvidence.hostCall)) { ...edited, result: SavedWithoutHost }
  else { ...edited, owner: s.serial + 1, savePhase: PrimaryPending, calls: s.calls + 1, result: NoSaveResult }
}
pure def alwaysAccessLockOwnerMatchesPhase(s: GoogleAccessSave): bool =
  s.serial >= 0 and s.owner >= 0 and ((s.savePhase == SaveIdle) == (s.owner == 0)) and (s.owner > 0 implies s.owner == s.serial)
pure def alwaysSecondChoiceWaitsBehindFirst(s: GoogleAccessSave): bool = s.secondPending implies s.pendingChoice
pure def stepQueuedChoicePreservesStores(before: GoogleAccessSave, via: str, after: GoogleAccessSave): bool =
  via == "queueAccessChoice" implies after.revision == before.revision and after.saved == before.saved and
    after.hostBits == before.hostBits and after.owner == before.owner
pure val weight_queueAccessChoice = 5
pure val weight_acquireAccessChoice = 6
```

### Native publication uses current saved values and keeps the original failure

On mount and device-settings changes, the panel requests publication
under the same lock. For native publication, initialization can start
loading preferences. Until a canonical read is ready, no default
bits go to the agent. The publisher rereads canonical preferences and
passes both current bits to the native bridge. The browser local-agent
development route is a best-effort POST. Its rejected fetch is absorbed.
An ordinary browser without that host publishes nothing.

A native publication rejection can occur before its commit or after
the host has stored the proposed bits. Either way the renderer tries
to restore both preceding bits, then invokes the same publisher on
the fresh canonical record. A rollback refusal before commit leaves
the new bits. A rollback can also commit before its own refresh
fails. Each outcome still reaches the corrective publisher, which
may fail or have no readable record. The lock remains held until that
attempt settles, so a waiting Google choice cannot interleave. The
caller receives the original publication error even when corrective
publication succeeds. If it refuses, the two stores can remain
different. The model records observed host commits separately from
returned acknowledgments and represents the original error by its kind.
A fresh canonical read supplies the two bits under the lock; independent
edits to unrelated preferences are outside this projection.

```quint
type AccessEnvironment = NativePhone | DevelopmentHost | BrowserWithoutHost
type PublishRoute = PublishNative | PublishDevelopment | SkipPublication
pure def accessPublicationRoute(accessEnvironment: AccessEnvironment, loaded: bool): PublishRoute =
  if (not(loaded)) SkipPublication
  else if (accessEnvironment == NativePhone) PublishNative
  else if (accessEnvironment == DevelopmentHost) PublishDevelopment else SkipPublication
type HostWrite = HostAcknowledged | HostRefused | HostReplyLost
pure def wroteHost(hostWrite: HostWrite): bool = hostWrite != HostRefused
pure def canObservePrimaryAccess(s: GoogleAccessSave): bool = s.savePhase == PrimaryPending
pure def observePrimaryAccess(s: GoogleAccessSave, hostWrite: HostWrite, rollbackLanded: bool, correctionAvailable: bool): GoogleAccessSave = {
  val afterHost: GoogleAccessSave = { ...s, hostBits: if (wroteHost(hostWrite)) s.saved else s.hostBits }
  val rolled: GoogleAccessSave = { ...afterHost, saved: if (rollbackLanded) s.previous else s.saved,
    revision: s.revision + (if (rollbackLanded) 1 else 0) }
  if (hostWrite == HostAcknowledged) { ...afterHost, savePhase: SaveIdle, owner: 0, result: AppliedSave }
  else if (correctionAvailable) { ...rolled, savePhase: CorrectionPending, calls: s.calls + 1 }
  else { ...rolled, savePhase: SaveIdle, owner: 0, result: PrimaryPublicationFailed }
}
pure def canObserveAccessCorrection(s: GoogleAccessSave): bool = s.savePhase == CorrectionPending
pure def observeAccessCorrection(s: GoogleAccessSave, hostWrite: HostWrite): GoogleAccessSave =
  { ...s, savePhase: SaveIdle, owner: 0, hostBits: if (wroteHost(hostWrite)) s.saved else s.hostBits, result: PrimaryPublicationFailed }
pure def stepCorrectionSurfacesOriginalFailure(before: GoogleAccessSave, via: str, after: GoogleAccessSave): bool =
  via == "observeAccessCorrection" implies after.result == PrimaryPublicationFailed and after.saved == before.saved
pure def lawUnloadedAccessHasNoHostWrite(accessEnvironment: AccessEnvironment): bool =
  accessPublicationRoute(accessEnvironment, false) == SkipPublication
pure def sometimesCorrectionKeepsLock(s: GoogleAccessSave): bool = s.savePhase == CorrectionPending and s.owner > 0
pure def sometimesFailedCorrectionLeavesDivergence(s: GoogleAccessSave): bool =
  s.result == PrimaryPublicationFailed and s.saved != s.hostBits
pure val weight_observePrimaryAccess = 5
pure val weight_observeAccessCorrection = 4
```

Pinned `test/quint-google-access-publication.test.mjs` executes the real
Google settings and preference wrappers against controlled document,
Web Lock and native ports. It distinguishes refusal, dropped response
after commit, rollback refusal, correction refusal and stale reviewed
receipt. `test/google-agent-access.test.mjs` checks the initial-load
gate and serialized independent choices. The fixtures stop at the
native bridge boundary. The `fixtureBits` initial state represents an
already-loaded preference record and synchronized native value used
by the refinement, while the route rule covers initial unknown settings.

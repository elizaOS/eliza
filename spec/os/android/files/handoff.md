# Files read-only handoff

How the files bridge lets another app, or the Files preview, read a file the
owner chose, and nothing more. Files are served by the host's nonexported
`<applicationId>.storage` provider (`ReadOnlyStorageFileProvider`, root
`storage/`). "Open with" and "Share" hand its URIs to Android's chooser with
read permission only; a tap opens the file in the Files preview through a
selection the [bridge](../bridge.md) host registers. The shell resolves
paths, builds the intents, waits on the UI thread and turns a `HandoffOutcome`
into a receipt with `receiptOfHandoff`. Source:
`plugins/plugin-native-filesystem/android/.../browser/ReadOnlyStorageFileProvider.java`
and the files plugin's `storageOpen`, `storageShare` and `storageSelect`.

## Story: Open or share a file without granting write

> As the owner, I want a file I open or share to reach the other app
> read-only, and the preview I asked for to show only the file I tapped, so
> that nothing can change my files or show me a file from a screen I left.

### The provider serves only a read with no hidden path segment

Every mode but `r` is refused, and so is any path with a segment that starts
with a dot. The trash folder's name always starts with a dot, so nothing in
the trash is ever served.

```quint
import bridge.* from "../bridge"
type OpenMode = ReadMode | WriteMode | ReadWriteMode
type PathSegment = PlainSegment | DotSegment | TrashFolderSegment
pure def hiddenSegment(segment: PathSegment): bool = segment != PlainSegment
pure def providerServes(mode: OpenMode, segments: List[PathSegment]): bool =
  mode == ReadMode and not(segments.some(segment => hiddenSegment(segment)))
pure def lawProviderServesOnlyVisibleReads(mode: OpenMode, segments: List[PathSegment]): bool =
  providerServes(mode, segments) implies (mode == ReadMode and segments.every(segment => segment == PlainSegment))
pure def lawTrashIsNeverServed(mode: OpenMode, segments: List[PathSegment]): bool =
  segments.includes(TrashFolderSegment) implies not(providerServes(mode, segments))
```

### A chooser is posted only for one regular file, or for one to 100 regular files to share

"Open with" needs a regular file. A share of more than 100 paths, of a
folder, or of a path that is not a file is refused before anything is posted.
One file goes out with Send, more with Send Multiple, every URI also in the
intent's clip data.

```quint
type ChooserRequest = OpenWith({ regularFile: bool }) | ShareFiles({ paths: int, regularFiles: int })
pure val maxShareFiles = 100
pure def handedFiles(request: ChooserRequest): int = match request {
  | OpenWith(o) => if (o.regularFile) 1 else 0
  | ShareFiles(f) => if (f.paths >= 1 and f.paths <= maxShareFiles and f.regularFiles == f.paths) f.paths else 0
}
pure val requestValues = Set(OpenWith({ regularFile: true }), OpenWith({ regularFile: false }),
  ShareFiles({ paths: 2, regularFiles: 2 }), ShareFiles({ paths: 3, regularFiles: 2 }),
  ShareFiles({ paths: 101, regularFiles: 101 }), ShareFiles({ paths: 0, regularFiles: 0 }))
pure def lawShareHandsOverEveryChosenFile(request: ChooserRequest): bool = match request {
  | ShareFiles(f) => handedFiles(request) > 0 implies (handedFiles(request) == f.paths and f.regularFiles == f.paths and f.paths <= maxShareFiles)
  | _ => handedFiles(request) <= 1
}
```

### A selection is shown only in the visit that requested it, and a late one is forgotten

Each visit to Files has a number, and leaving it or changing folder starts the
next and closes its preview. The bridge takes one call at a time. A tap asks
for a selection; when the selection returns after its visit ended it is
forgotten, never shown. A selection that did not come back in the current
visit is reported as a file that could not open.

```quint
type FilesCall = Idle | AwaitingSelection({ visit: int }) | AwaitingChooser({ ticket: int, files: int })
type PreviewShown = NothingShown | Showing({ selectionId: str, visit: int })
type HandoffReply = NoHandoffYet | Handed({ ticket: int, answer: HandoffOutcome, files: int })
type FilesPreview = { visit: int, call: FilesCall, shown: PreviewShown, tickets: int, queued: Set[int], lastHandoff: HandoffReply }
type PreviewEffect = ForgetSelection({ selectionId: str }) | ShowCouldNotOpen
type PreviewStep = { state: FilesPreview, out: List[PreviewEffect] }
pure val initial: FilesPreview = { visit: 0, call: Idle, shown: NothingShown, tickets: 0, queued: Set(), lastHandoff: NoHandoffYet }
pure def awaitedVisit(c: FilesCall): int = match c { | AwaitingSelection(a) => a.visit | _ => -1 }
pure def leaveFiles(s: FilesPreview): FilesPreview = { ...s, visit: s.visit + 1, shown: NothingShown }
pure def canRequestPreview(s: FilesPreview): bool = s.call == Idle
pure def requestPreview(s: FilesPreview): FilesPreview = { ...s, call: AwaitingSelection({ visit: s.visit }) }
pure def canSettlePreview(s: FilesPreview): bool = awaitedVisit(s.call) >= 0
pure def settlePreview(s: FilesPreview, selectionId: str): PreviewStep =
  if (awaitedVisit(s.call) != s.visit)
    { state: { ...s, call: Idle }, out: if (selectionId == "") List() else List(ForgetSelection({ selectionId: selectionId })) }
  else if (selectionId == "") { state: { ...s, call: Idle }, out: List(ShowCouldNotOpen) }
  else { state: { ...s, call: Idle, shown: Showing({ selectionId: selectionId, visit: s.visit }) }, out: List() }
pure val selectionIdValues = Set("", "selection-1", "selection-2")
pure def isForget(e: PreviewEffect): bool = match e { | ForgetSelection(f) => f.selectionId != "" | _ => false }
pure def stepOnlyTheRequestingVisitShowsItsSelection(before: FilesPreview, via: str, after: FilesPreview, out: List[PreviewEffect]): bool =
  via == "settlePreview" implies
    ((after.shown != before.shown implies awaitedVisit(before.call) == before.visit) and
     (awaitedVisit(before.call) != before.visit implies (after.shown == before.shown and out.every(e => isForget(e)))))
pure def sometimesSelectionOutlivesItsVisit(s: FilesPreview): bool = awaitedVisit(s.call) >= 0 and awaitedVisit(s.call) < s.visit
pure def shownVisit(p: PreviewShown): int = match p { | Showing(x) => x.visit | _ => -1 }
pure def shownSelection(p: PreviewShown): str = match p { | Showing(x) => x.selectionId | _ => "" }
pure def sometimesPreviewShownInALaterVisit(s: FilesPreview): bool = shownVisit(s.shown) >= 1
```

### A chooser reply reports dispatch only, and a start that comes after the timeout never changes it

The worker posts the chooser's start to the UI thread and waits up to five
seconds. A start that succeeded first is `Opened` with the number of files
handed over; no Activity, a failed start or the timeout is `Refused`. A start
still queued after the timeout may show the chooser, but the call was already
answered. `Opened` says only that Android showed its chooser: it is never a
delivery. "Open with" keeps the preview on screen.

```quint
pure def awaitedTicket(c: FilesCall): int = match c { | AwaitingChooser(a) => a.ticket | _ => 0 }
pure def awaitedFiles(c: FilesCall): int = match c { | AwaitingChooser(a) => a.files | _ => 0 }
pure def handedTicket(h: HandoffReply): int = match h { | Handed(x) => x.ticket | _ => 0 }
pure def canPostChooser(s: FilesPreview): bool = s.call == Idle
pure def postChooser(s: FilesPreview, request: ChooserRequest, activityPresent: bool): FilesPreview = {
  val ticket = s.tickets + 1
  if (handedFiles(request) == 0 or not(activityPresent)) { ...s, tickets: ticket, lastHandoff: Handed({ ticket: ticket, answer: Refused, files: 0 }) }
  else { ...s, tickets: ticket, call: AwaitingChooser({ ticket: ticket, files: handedFiles(request) }), queued: s.queued.union(Set(ticket)) }
}
pure def canTimeOutChooser(s: FilesPreview): bool = awaitedTicket(s.call) > 0
pure def timeOutChooser(s: FilesPreview): FilesPreview =
  { ...s, call: Idle, lastHandoff: Handed({ ticket: awaitedTicket(s.call), answer: Refused, files: 0 }) }
pure def canStartChooser(s: FilesPreview, ticket: int): bool = s.queued.contains(ticket)
pure def startChooser(s: FilesPreview, ticket: int, launched: bool): FilesPreview =
  if (ticket > 0 and awaitedTicket(s.call) == ticket)
    { ...s, queued: s.queued.exclude(Set(ticket)), call: Idle,
      lastHandoff: Handed({ ticket: ticket, answer: if (launched) Opened else Refused, files: if (launched) awaitedFiles(s.call) else 0 }) }
  else { ...s, queued: s.queued.exclude(Set(ticket)) }
pure val ticketValues = Set(1, 2, 3)
pure def stepReplyIsNeverRevised(before: FilesPreview, after: FilesPreview): bool =
  handedTicket(after.lastHandoff) == handedTicket(before.lastHandoff) implies after.lastHandoff == before.lastHandoff
pure def stepChooserKeepsThePreview(before: FilesPreview, via: str, after: FilesPreview): bool =
  (via == "postChooser" or via == "timeOutChooser" or via == "startChooser") implies after.shown == before.shown
pure def repliedOpened(h: HandoffReply): bool = match h { | Handed(x) => x.answer == Opened | _ => false }
pure def repliedRefused(h: HandoffReply): bool = match h { | Handed(x) => x.answer == Refused | _ => false }
pure def repliedFiles(h: HandoffReply): int = match h { | Handed(x) => x.files | _ => 0 }
pure def sometimesShareOpened(s: FilesPreview): bool = repliedOpened(s.lastHandoff) and repliedFiles(s.lastHandoff) >= 2
pure def sometimesTimedOutStartStillQueued(s: FilesPreview): bool =
  repliedRefused(s.lastHandoff) and s.queued.contains(handedTicket(s.lastHandoff))
pure def sometimesPreviewStaysWhileChooserWaits(s: FilesPreview): bool = s.shown != NothingShown and awaitedTicket(s.call) > 0
```

### Every pending call, preview and reply belongs to an issued visit or ticket

These are the facts the step rules above rely on: a waiting chooser call is
newer than the last reply, so answering it never revises an earlier reply,
and an `Opened` reply counts only files that were handed over.

```quint
pure def alwaysCallsBelongToIssuedVisitsAndTickets(s: FilesPreview): bool =
  s.visit >= 0 and s.tickets >= 0 and
  s.queued.forall(t => t >= 1 and t <= s.tickets) and
  awaitedVisit(s.call) <= s.visit and
  (s.call == Idle or awaitedVisit(s.call) >= 0 or
    (awaitedTicket(s.call) >= 1 and awaitedTicket(s.call) <= s.tickets and s.queued.contains(awaitedTicket(s.call)) and
     awaitedFiles(s.call) >= 1 and awaitedFiles(s.call) <= maxShareFiles and handedTicket(s.lastHandoff) < awaitedTicket(s.call)))
pure def alwaysPreviewIsOfThisVisit(s: FilesPreview): bool =
  s.shown == NothingShown or (shownVisit(s.shown) == s.visit and shownSelection(s.shown) != "")
pure def alwaysReplyCountsOnlyOpenedFiles(s: FilesPreview): bool =
  s.lastHandoff == NoHandoffYet or
    (handedTicket(s.lastHandoff) >= 1 and handedTicket(s.lastHandoff) <= s.tickets and
     (if (repliedOpened(s.lastHandoff)) repliedFiles(s.lastHandoff) >= 1 and repliedFiles(s.lastHandoff) <= maxShareFiles
      else repliedFiles(s.lastHandoff) == 0))
```

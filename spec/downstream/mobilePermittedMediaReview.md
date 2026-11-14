# Android permitted Photos mutation review

AlphaPhone `8d44dfe5` installs Eliza `c518127a`'s `PhotosPlugin` and
`DeviceLibraryPlugin` through `AlphaPhotosPlugin.java` and
`AlphaPhotoLibraryPlugin.java`. Alpha's `camera-adapter.ts` calls the
single-item flag, batch and selected permanent-delete methods.
`photo-library-adapter.ts` confirms agent-proposed changes via the shared
`DeviceLibraryPlugin.requestChange` method. These bridges share the
`PermittedMediaReview` launcher and `PermittedMediaCatalog` in
`plugins/plugin-native-media/android/src/main/java/ai/eliza/plugins/media`.
The pinned Grace bridge uses the read-only `PermittedPhotosPlugin`.
[Media permissions](./mobilePhotos.md) govern catalog reads.
[Photos view receipts](./mobileDevicePhotos.md) govern the renderer's
review handoff. [Owned trash](./mobileOwnedPhotoTrash.md) governs a
separate direct-write path. [Photo replacement](./mobilePhotoReplace.md)
owns the continuation after a write grant for one edited still image.

Eliza's `test/native-host/permitted-catalog.node.mjs` transplants the
pinned deletion and review method bodies into controlled JVM provider,
launcher and Activity lifecycle fixtures. The Photos fixture checks
the immutable selected list, two approvals waiting for resume, expiry,
decline, destruction, partial row results, and one dispatch per
accepted request. The source fixture does not deliver Android's
permission grant or run MediaStore.

## Story: Review the exact permitted media before asking Android to authorize a change

### The launcher captures one valid selection and local confirmation precedes the Android grant

Android 11 or later is required. A review starts with immutable
ordered IDs and mutation revisions, and distinct IDs. A native single
flag action expects one item. A direct Photos flag batch admits up to
500. A selected permanent deletion or agent batch admits up to 20.
The agent requests favorite, unfavorite or trash. The
explicit native editor Replace request is limited to one untrashed
still image. No permitted-library entry point takes an empty
selection as authority to delete the whole trash.

The native Photos renderer uses the 500-row limit when every
selected key is permitted. Every other selection uses 20-row chunks
in original order. The chunker does not partition by key kind.
If a mixed chunk reaches `PhotosPlugin`, the presence of an `m:`
ID selects the permitted reviewer for the whole input. Owned
numeric keys then fail the typed catalog lookup. A permitted key
can denote an app-owned item as seen through the permitted catalog.
It is the key form, not the item's owner flag, that selects this route.

The native port parses the typed key, verifies the volume and reads the
published row under current authority. The mutation revision includes
the provider version, date, size, modified time and native generation
counters. A nonempty revision is at most 256 Java UTF-16 code units. Preparation
fails if the selected revision has changed.
Favoriting and unfavoriting a trashed row are refused. Permanent
deletion requires a trashed row. The owner receives a native dialog
naming the selected items, then may continue into the Android
MediaStore write request. Replace starts at the Android dialog because
the editor supplied the local review. Both paths check focus before
the first presentation and the same request identity and two-minute
deadline whenever a local confirmation is used. Replace still shares
the same Android result and activity-resume checks. The deadline is inclusive at
`until`. Launch rejection clears only that pending request. The
scope includes the one-shot authority, with the actual dialog,
Activity launcher and worker provided as native effects.

```quint
type MediaReviewOp = MediaFavorite | MediaUnfavorite | MediaTrash | MediaRestore | MediaErase | MediaReplace
type MediaReviewRoute = SinglePhoto | NativePhotoBatch | AgentPhotoBatch | EditorReplace
type ReviewedMedia = { key: str, revision: str, revisionUnits: int, typedKey: bool, readable: bool,
  revisionCurrent: bool, trashed: bool, video: bool }
type MediaReviewInput = { operation: MediaReviewOp, route: MediaReviewRoute, android11: bool,
  rows: List[ReviewedMedia] }
pure def favoriteReview(operation: MediaReviewOp): bool = operation == MediaFavorite or operation == MediaUnfavorite
pure def validReviewRoute(operation: MediaReviewOp, route: MediaReviewRoute): bool =
  if (route == EditorReplace) operation == MediaReplace
  else if (operation == MediaReplace) false
  else if (route == AgentPhotoBatch) favoriteReview(operation) or operation == MediaTrash
  else if (operation == MediaErase) route == NativePhotoBatch
  else true
pure def reviewRowMatches(operation: MediaReviewOp, row: ReviewedMedia): bool =
  row.key != "" and row.revision != "" and row.revisionUnits >= 1 and row.revisionUnits <= 256 and
    row.typedKey and row.readable and row.revisionCurrent and
    (if (favoriteReview(operation)) not(row.trashed)
     else if (operation == MediaErase) row.trashed
     else if (operation == MediaReplace) not(row.trashed or row.video) else true)
pure def reviewItemLimit(operation: MediaReviewOp, route: MediaReviewRoute): int =
  if (route == SinglePhoto or route == EditorReplace) 1
  else if (route == AgentPhotoBatch or operation == MediaErase) 20 else 500
pure def validMediaReview(input: MediaReviewInput): bool =
  input.android11 and validReviewRoute(input.operation, input.route) and
    input.rows.length() >= 1 and input.rows.length() <= reviewItemLimit(input.operation, input.route) and
    input.rows.every(row => reviewRowMatches(input.operation, row)) and
    input.rows.every(row => input.rows.select(candidate => candidate.key == row.key).length() == 1)
pure val gardenPhoto: ReviewedMedia = { key: "m:external_primary:i:7", revision: "r1", revisionUnits: 2, typedKey: true,
  readable: true, revisionCurrent: true, trashed: false, video: false }
pure val porchPhoto: ReviewedMedia = { ...gardenPhoto, key: "m:external_primary:i:8", revision: "r2" }
pure val proposedReview: MediaReviewInput = { operation: MediaTrash, route: NativePhotoBatch,
  android11: true, rows: List(gardenPhoto, porchPhoto) }
pure val inputValues = Set(proposedReview, { ...proposedReview, rows: List(gardenPhoto) },
  { ...proposedReview, route: AgentPhotoBatch }, { ...proposedReview, route: SinglePhoto, rows: List(gardenPhoto) },
  { ...proposedReview, operation: MediaErase, rows: List({ ...gardenPhoto, trashed: true }) },
  { ...proposedReview, operation: MediaReplace, route: EditorReplace, rows: List(porchPhoto) },
  { ...proposedReview, rows: List() }, { ...proposedReview, rows: List(gardenPhoto, gardenPhoto) })
pure def lawPermittedEraseNamesPublishedTrashedItems(input: MediaReviewInput, row: ReviewedMedia): bool =
  validMediaReview(input) and input.operation == MediaErase and input.rows.includes(row) implies
    input.route == NativePhotoBatch and input.rows.length() <= 20 and row.typedKey and row.readable and
      row.revisionCurrent and row.trashed
pure def lawAgentMediaReviewOnlyAdmitsItsThreeActions(input: MediaReviewInput): bool =
  validMediaReview(input) and input.route == AgentPhotoBatch implies
    favoriteReview(input.operation) or input.operation == MediaTrash
pure val rowValues = Set(gardenPhoto, porchPhoto, { ...gardenPhoto, trashed: true },
  { ...gardenPhoto, typedKey: false }, { ...gardenPhoto, video: true })
```

### Each Android approval keeps its own immutable selection through resume

The launcher atomically consumes the one pending request on Android
result. A declined, expired or closed request dispatches no effects.
An accepted request dispatches immediately if the Activity is resumed.
Otherwise an observer captures that exact request until `ON_RESUME`
or `ON_DESTROY`. A later submission may occupy the freed launcher
slot while previous approvals wait. More than one approved request
can wait for resume. Each retains its own snapshots. A timer alone
does not free an unanswered launcher slot. Resume checks deadline
and closure again, removes its observer and queues one worker action.
Closing the plugin rejects the pending dialog and removes its launcher.
Observers waiting on lifecycle still settle on their own resume or
destroy callback. The Android launcher delivers one result per launched
system request, with no caller-supplied row list. The model uses a
monotonic ID for each local request and a captured ticket for the
one-shot resume. A queued ticket carries the immutable selection to
the single worker in dispatch order. Closing the host does not
grant a queued flag action the right to write. Independent lifecycle observers are modeled separately
even when a single platform resume notifies more than one.

```quint
type MediaDialogPhase = NoMediaDialog | ReviewPosted | ReviewShowing | AndroidGrant
type MediaReviewReply = NoMediaReply | MediaRefused | MediaDeclined | MediaClosed | MediaQueued
type MediaTicket = { id: int, until: int, original: MediaReviewInput }
type PermittedReview = { now: int, serial: int, closed: bool, dialog: MediaDialogPhase,
  slot: MediaTicket, waiting: List[MediaTicket], workerQueue: List[MediaTicket], dispatched: MediaTicket, reply: MediaReviewReply }
pure val emptyMediaTicket: MediaTicket = { id: 0, until: 0, original: proposedReview }
pure val initial: PermittedReview = { now: 0, serial: 0, closed: false, dialog: NoMediaDialog,
  slot: emptyMediaTicket, waiting: List(), workerQueue: List(), dispatched: emptyMediaTicket, reply: NoMediaReply }
pure def freshReview(ticket: MediaTicket, now: int): bool = ticket.id > 0 and now <= ticket.until
pure def canBeginPermittedReview(s: PermittedReview, input: MediaReviewInput): bool =
  not(s.closed) and s.dialog == NoMediaDialog and validMediaReview(input)
pure def beginPermittedReview(s: PermittedReview, input: MediaReviewInput): PermittedReview =
  { ...s, serial: s.serial + 1, dialog: ReviewPosted, reply: NoMediaReply,
    slot: { id: s.serial + 1, until: s.now + 120000, original: input } }
pure def canPresentMediaReview(s: PermittedReview): bool = s.dialog == ReviewPosted
pure def presentMediaReview(s: PermittedReview, focused: bool, launchAccepted: bool): PermittedReview =
  if (s.closed or not(focused and freshReview(s.slot, s.now))) retireMediaSlot(MediaDeclined, s)
  else if (s.slot.original.operation != MediaReplace) { ...s, dialog: ReviewShowing }
  else if (launchAccepted) { ...s, dialog: AndroidGrant }
  else retireMediaSlot(MediaRefused, s)
pure def retireMediaSlot(reply: MediaReviewReply, s: PermittedReview): PermittedReview =
  { ...s, slot: emptyMediaTicket, dialog: NoMediaDialog, reply: reply }
pure def canAnswerLocalMediaReview(s: PermittedReview): bool = s.dialog == ReviewShowing
pure def answerLocalMediaReview(s: PermittedReview, allowed: bool, launchAccepted: bool): PermittedReview =
  if (s.closed or not(allowed and freshReview(s.slot, s.now))) retireMediaSlot(MediaDeclined, s)
  else if (launchAccepted) { ...s, dialog: AndroidGrant }
  else retireMediaSlot(MediaRefused, s)
pure def canReceiveAndroidMediaResult(s: PermittedReview): bool = s.dialog == AndroidGrant
pure def receiveAndroidMediaResult(s: PermittedReview, granted: bool, resumed: bool, queued: bool): PermittedReview =
  if (s.closed or not(granted and freshReview(s.slot, s.now))) retireMediaSlot(MediaDeclined, s)
  else if (not(resumed)) {
    ...retireMediaSlot(NoMediaReply, s), waiting: s.waiting.append(s.slot)
  } else if (queued) { ...retireMediaSlot(MediaQueued, s), dispatched: s.slot, workerQueue: s.workerQueue.append(s.slot) }
  else retireMediaSlot(MediaClosed, s)
pure def awaitingTicket(tickets: List[MediaTicket], reviewId: int): MediaTicket =
  tickets.select(ticket => ticket.id == reviewId).nthOr(0, emptyMediaTicket)
pure def canSettleMediaResume(s: PermittedReview, reviewId: int): bool =
  reviewId > 0 and awaitingTicket(s.waiting, reviewId).id == reviewId
pure def settleMediaResume(s: PermittedReview, reviewId: int, destroyed: bool, queued: bool): PermittedReview = {
  val ticket = awaitingTicket(s.waiting, reviewId)
  val reply = if (destroyed) MediaClosed else if (s.closed or not(freshReview(ticket, s.now))) MediaDeclined
    else if (queued) MediaQueued else MediaClosed
  { ...s, waiting: s.waiting.select(prior => prior.id != reviewId),
    workerQueue: if (reply == MediaQueued) s.workerQueue.append(ticket) else s.workerQueue,
    dispatched: if (reply == MediaQueued) ticket else s.dispatched, reply: reply }
}
pure def canTakePermittedMediaWorker(s: PermittedReview): bool = s.workerQueue.length() > 0
pure def takePermittedMediaWorker(s: PermittedReview): PermittedReview =
  { ...s, workerQueue: s.workerQueue.removeAt(0) }
pure def nextPermittedMediaWorker(s: PermittedReview): MediaTicket =
  s.workerQueue.nthOr(0, emptyMediaTicket)
pure def stepQueuedMediaDispatchRetainsItsSnapshot(before: PermittedReview, via: str, after: PermittedReview): bool =
  (via == "receiveAndroidMediaResult" or via == "settleMediaResume") and after.reply == MediaQueued implies
    after.workerQueue == before.workerQueue.append(after.dispatched)
pure def stepNativeMediaWorkerConsumesOneQueuedTicket(before: PermittedReview, via: str, after: PermittedReview): bool =
  via == "takePermittedMediaWorker" implies
    before.workerQueue.length() > 0 and after.workerQueue == before.workerQueue.removeAt(0)
pure def canAdvanceMediaReviewClock(s: PermittedReview, observedClock: int): bool = observedClock > s.now
pure def advanceMediaReviewClock(s: PermittedReview, observedClock: int): PermittedReview = { ...s, now: observedClock }
pure def canClosePermittedMediaReview(s: PermittedReview): bool = not(s.closed)
pure def closePermittedMediaReview(s: PermittedReview): PermittedReview =
  { ...retireMediaSlot(MediaClosed, s), closed: true }
pure val observedClockValues = Set(1, 120000, 120001, 240002)
pure val reviewIdValues = Set(0, 1, 2, 3, 4)
pure val weight_beginPermittedReview = 10
pure val weight_presentMediaReview = 13
pure val weight_answerLocalMediaReview = 15
pure val weight_receiveAndroidMediaResult = 16
pure val weight_settleMediaResume = 14
pure val weight_takePermittedMediaWorker = 10
pure def alwaysClosedReviewHasNoPrompt(s: PermittedReview): bool = s.closed implies s.dialog == NoMediaDialog
pure def stepResumeKeepsTheNewerLauncherSlot(before: PermittedReview, via: str, after: PermittedReview): bool =
  via == "settleMediaResume" implies after.slot == before.slot and after.dialog == before.dialog
pure def stepDirectGrantDispatchUsesItsCapturedSlot(before: PermittedReview, via: str, after: PermittedReview): bool =
  via == "receiveAndroidMediaResult" and after.reply == MediaQueued implies
    after.dispatched == before.slot and freshReview(before.slot, before.now) and after.dialog == NoMediaDialog
pure def sometimesPermittedReviewReachesAndroid(s: PermittedReview): bool = s.dialog == AndroidGrant
pure def sometimesPermittedReviewAwaitsResumeWithNewPrompt(s: PermittedReview): bool =
  s.waiting.length() > 0 and s.dialog != NoMediaDialog
pure def sometimesTwoApprovedSelectionsWaitIndependently(s: PermittedReview): bool = s.waiting.length() >= 2
pure def sometimesPermittedReviewDispatches(s: PermittedReview): bool = s.reply == MediaQueued and s.dispatched.id > 0
```

## Story: Change and report only the rows that still match the approved review

### Each row checks the current revision and provider readback before reporting success

The worker checks closure and deadline for each captured row before
calling the catalog. A stop or timeout marks remaining rows unverified.
The same typed volume and media row must still be visible to the
provider. For favorite and trash flags a qualified no-op returns
`unchanged`. Otherwise the catalog reads the exact mutation revision
again and uses a typed provider update with pending state, generation
added, generation modified and opposite flag predicates. Favorite
also predicates that the row is not trashed. Write authority is
checked immediately before that operation. One affected row, desired
flag readback and the same stable identity yield a verified change.
A verified change invalidates catalog state.

Permanent deletion requires the captured row to still be trashed and
uses the typed volume and generation predicates again. Only one
affected row followed by verified absence of that ID in the typed
collection acknowledges deletion. A readable cursor with any row
present or an unavailable cursor makes the outcome unverified. The
origin row must be readable at the start. An initial missing or
unavailable row may raise an access error and is then unverified.
An exact revision mismatch, a restored row, or a guarded update with
the wrong affected count yields stale. The native bridge classifies
the literal stale exception separately from other failures. It never
treats a lost readback as a success. The worker projects row IDs from the captured selection in its
original order, and a batch is complete only when every row
is verified. A single-row flag failure rejects the call. Replace
hands off the granted continuation rather than entering this
flag/delete loop.

```quint
type MediaRowEvidence = { liveAtRow: bool, deadlineCurrent: bool, readable: bool, revisionExact: bool,
  trashed: bool, alreadyDesired: bool, recheckedRevision: bool, writeAllowed: bool,
  counted: bool, affectedRows: int, readbackKnown: bool, desiredFlag: bool, stableIdentity: bool, absent: bool }
type MediaRowOutcome = { key: str, reply: MediaRowReply }
type MediaRowReply = MediaStale | MediaUnverified | MediaUnchanged | MediaFlagChanged | MediaDeleted
pure def reviewEffectMatches(operation: MediaReviewOp, evidence: MediaRowEvidence): bool =
  if (favoriteReview(operation)) not(evidence.trashed)
  else if (operation == MediaErase) evidence.trashed else operation != MediaReplace
pure def mediaRowReply(operation: MediaReviewOp, evidence: MediaRowEvidence): MediaRowReply =
  if (not(evidence.liveAtRow and evidence.deadlineCurrent and evidence.readable)) MediaUnverified
  else if (not(evidence.revisionExact and reviewEffectMatches(operation, evidence))) MediaStale
  else if (operation != MediaErase and evidence.alreadyDesired) MediaUnchanged
  else if (not(evidence.recheckedRevision)) MediaStale
  else if (not(evidence.writeAllowed and evidence.counted)) MediaUnverified
  else if (evidence.affectedRows != 1) MediaStale
  else if (not(evidence.readbackKnown)) MediaUnverified
  else if (operation == MediaErase) { if (evidence.absent) MediaDeleted else MediaUnverified }
  else if (evidence.desiredFlag and evidence.stableIdentity) MediaFlagChanged else MediaUnverified
pure def verifiedMediaReply(reply: MediaRowReply): bool =
  reply == MediaUnchanged or reply == MediaFlagChanged or reply == MediaDeleted
pure def capturedMediaOutcome(ticket: MediaTicket, position: int, evidence: MediaRowEvidence): MediaRowOutcome = {
  val captured = ticket.original.rows.nthOr(position, gardenPhoto)
  if (position < 0 or position >= ticket.original.rows.length())
    { key: "", reply: MediaUnverified }
  else { key: captured.key, reply: mediaRowReply(ticket.original.operation, evidence) }
}
pure def mediaBatchComplete(outcomes: List[MediaRowReply]): bool = outcomes.every(verifiedMediaReply)
pure val exactProviderReply: MediaRowEvidence = { liveAtRow: true, deadlineCurrent: true, readable: true,
  revisionExact: true, trashed: true, alreadyDesired: false, recheckedRevision: true, writeAllowed: true,
  counted: true, affectedRows: 1, readbackKnown: true, desiredFlag: true, stableIdentity: true, absent: true }
pure val evidenceValues = Set(exactProviderReply, { ...exactProviderReply, readbackKnown: false },
  { ...exactProviderReply, revisionExact: false }, { ...exactProviderReply, deadlineCurrent: false },
  { ...exactProviderReply, affectedRows: 0 }, { ...exactProviderReply, absent: false },
  { ...exactProviderReply, trashed: false }, { ...exactProviderReply, alreadyDesired: true })
pure def lawPermittedDeleteRequiresReadback(operation: MediaReviewOp, evidence: MediaRowEvidence): bool =
  mediaRowReply(operation, evidence) == MediaDeleted implies
    operation == MediaErase and evidence.trashed and evidence.revisionExact and evidence.recheckedRevision and
    evidence.writeAllowed and evidence.counted and evidence.affectedRows == 1 and evidence.readbackKnown and evidence.absent
pure def lawPermittedFlagNeedsSameIdentityAndReadback(operation: MediaReviewOp, evidence: MediaRowEvidence): bool =
  mediaRowReply(operation, evidence) == MediaFlagChanged implies
    evidence.revisionExact and evidence.recheckedRevision and evidence.affectedRows == 1 and
    evidence.readbackKnown and evidence.desiredFlag and evidence.stableIdentity
pure val ticketValues = Set(emptyMediaTicket, { id: 1, until: 120000, original: proposedReview })
pure val positionValues = Set(-1, 0, 1, 2)
pure def lawStoppedReviewCannotConfirmAnyRow(operation: MediaReviewOp, evidence: MediaRowEvidence): bool =
  not(evidence.liveAtRow and evidence.deadlineCurrent) implies not(verifiedMediaReply(mediaRowReply(operation, evidence)))
```

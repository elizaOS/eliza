# Alpha Android Files preview and read-only handoff

AlphaPhone `8d44dfe5` binds Eliza's
`plugins/plugin-files/src/browser/files-browser-adapter.ts` to
`AlphaFiles` in `apps/app/src/prototype/selection-adapter.ts`.
`AlphaFilesPlugin.java` uses `StorageBrowser` and the installed
`ReadOnlyStorageFileProvider` from Eliza `c518127a`, under
`plugins/plugin-native-filesystem/android/src/main/java/ai/eliza/plugins/filesystem/browser`.
The [Files mutation model](./mobileFilesMutationCustody.md) owns storage
and write admission. The [document grant registry](./mobileSelectedDocumentGrants.md)
owns selected URI custody after authorization. This model follows an
existing file through the Alpha-owned provider and the Files renderer
or Android chooser. Grace does not install this Alpha Files bridge.

Pinned `test/files-picker-lifecycle.test.mjs` exercises the shared
renderer source against held bridge replies. The prior `FilesPreview.qnt`
and its source driver at `specs/quint/refinement/application/files-preview.mjs`
cover current, retired and returned Files view completions. The provider
rules below come from the shipped Java class and manifest. Renderer
fixtures supply synthetic bridge results.

## Story: Open the selected file with read-only authority

### The chosen volume path must resolve to a file and the provider serves only visible read requests

The native Files worker checks access, the selected volume and a
volume-relative path. An open or selection needs a regular file.
The host maps that file to its own `content` URI through the
`<applicationId>.storage` provider. The installed provider is
nonexported, grants URI permissions and uses the `storage/` root.
The platform must supply actual provider root resolution and caller
authority to the adapter. The provider's `openFile` further refuses
every mode except the literal `r` and any decoded URI path segment
beginning with a dot, including the trash namespace. Its inherited
provider opens the path. There is no immutable copy or byte digest
in this grant. An external reader needs the platform's read grant
when opening the handle.

```quint
type FilesReadPort = { workerLive: bool, storageGranted: bool, volumeResolved: bool,
  pathAdmitted: bool, regularFile: bool, ownProviderUri: bool }
pure def admitsFileReadPath(port: FilesReadPort): bool =
  port.workerLive and port.storageGranted and port.volumeResolved and port.pathAdmitted and port.regularFile and port.ownProviderUri
pure val readableFile: FilesReadPort = { workerLive: true, storageGranted: true, volumeResolved: true, pathAdmitted: true,
  regularFile: true, ownProviderUri: true }
pure val portValues = Set(readableFile, { ...readableFile, pathAdmitted: false }, { ...readableFile, regularFile: false },
  { ...readableFile, ownProviderUri: false }, { ...readableFile, storageGranted: false })
type StorageOpenEvidence = { callerAuthorized: bool, providerBound: bool, mode: str, hiddenSegment: bool }
pure def admitsStorageProviderRead(proof: StorageOpenEvidence): bool =
  proof.callerAuthorized and proof.providerBound and proof.mode == "r" and not(proof.hiddenSegment)
pure val allowedRead: StorageOpenEvidence = { callerAuthorized: true, providerBound: true, mode: "r", hiddenSegment: false }
pure val proofValues = Set(allowedRead, { ...allowedRead, mode: "rw" }, { ...allowedRead, mode: "w" },
  { ...allowedRead, hiddenSegment: true }, { ...allowedRead, callerAuthorized: false })
pure def lawFilesReadNeedsTheNativePath(port: FilesReadPort): bool =
  admitsFileReadPath(port) implies port.volumeResolved and port.pathAdmitted and port.regularFile and port.ownProviderUri
pure def lawFilesProviderNeverAdmitsWriteOrHidden(proof: StorageOpenEvidence): bool =
  admitsStorageProviderRead(proof) implies proof.mode == "r" and not(proof.hiddenSegment) and proof.callerAuthorized
```

### Android chooser acknowledgement confirms dispatch only

`storageOpen` builds an Android View chooser with the file's URI,
MIME type and read permission. `storageShare` accepts 1–100 distinct
paths and validates the resolved paths. Nonfiles are omitted. It
refuses when there are no files. One file uses Send and more than
one uses Send Multiple. The MIME is the common exact type if all
types match and `*/*` otherwise. The intent carries the chosen URI
sequence as streams and in ClipData, with read permission. The
`opened` share receipt reports the number of URIs handed to the
chooser. It is independent of choosing a recipient or reading bytes.

The storage worker posts a start to the UI thread when an Activity
exists and waits up to five seconds. Missing Activity or a failed
start yields `unsupported` for Open and `failed` for Share. If
waiting times out, the same refusal is returned and the posted
callback may still start the chooser. The callback cannot change
the worker's reply. The latch is modeled as a race between timeout
and the start result. The model gives one call a single response.
The host supplies the actual Activity and Android start result.
This chooser grants no new write access and no delivery receipt.

```quint
type ChooserKind = OpenFileWith | ShareFiles
type AndroidIntentKind = NoFilesIntent | FilesViewIntent | FilesSendIntent | FilesSendMultipleIntent
pure def openFileIntent(port: FilesReadPort): AndroidIntentKind =
  if (admitsFileReadPath(port)) FilesViewIntent else NoFilesIntent
type SharePlan = { paths: int, distinctPaths: bool, exactPaths: bool, shareable: int, sameMime: bool, mime: str }
pure def shareIntent(plan: SharePlan): AndroidIntentKind =
  if (plan.paths < 1 or plan.paths > 100 or not(plan.distinctPaths and plan.exactPaths) or
       plan.shareable < 1 or plan.shareable > plan.paths) NoFilesIntent
  else if (plan.shareable == 1) FilesSendIntent else FilesSendMultipleIntent
pure def shareMime(plan: SharePlan): str = if (plan.sameMime) plan.mime else "*/*"
pure val oneFileShare: SharePlan = { paths: 1, distinctPaths: true, exactPaths: true, shareable: 1,
  sameMime: true, mime: "text/plain" }
pure val planValues = Set(oneFileShare, { ...oneFileShare, paths: 3, shareable: 2, sameMime: false },
  { ...oneFileShare, paths: 2, exactPaths: false }, { ...oneFileShare, shareable: 0 },
  { ...oneFileShare, paths: 101 })
pure def lawShareIntentsBindTheSelectedFiles(plan: SharePlan): bool =
  shareIntent(plan) != NoFilesIntent implies plan.exactPaths and plan.distinctPaths and
    plan.paths <= 100 and plan.shareable >= 1 and plan.shareable <= plan.paths
pure def lawMixedTypesUseGenericShareMime(plan: SharePlan): bool =
  not(plan.sameMime) implies shareMime(plan) == "*/*"
type ChooserReply = NoChooserReply | ChooserOpened | ChooserUnsupported | ChooserFailed
pure def refusedChooser(kind: ChooserKind): ChooserReply =
  if (kind == OpenFileWith) ChooserUnsupported else ChooserFailed
type ChooserLatch = { kind: ChooserKind, posted: bool, waiting: bool, started: bool, reply: ChooserReply }
pure def queueChooser(kind: ChooserKind, activityAvailable: bool): ChooserLatch =
  { kind: kind, posted: activityAvailable, waiting: activityAvailable, started: false,
    reply: if (activityAvailable) NoChooserReply else refusedChooser(kind) }
pure def finishChooser(latch: ChooserLatch, launched: bool): ChooserLatch =
  if (not(latch.posted)) latch
  else { ...latch, posted: false, waiting: false, started: launched,
    reply: if (not(latch.waiting)) latch.reply else if (launched) ChooserOpened else refusedChooser(latch.kind) }
pure def timeOutChooser(latch: ChooserLatch): ChooserLatch =
  if (not(latch.waiting)) latch
  else { ...latch, waiting: false, reply: refusedChooser(latch.kind) }
pure val latchValues = Set(queueChooser(OpenFileWith, true), queueChooser(ShareFiles, true),
  queueChooser(OpenFileWith, false), timeOutChooser(queueChooser(ShareFiles, true)))
pure def lawPendingUiCallbackCannotReplaceChooserTimeout(latch: ChooserLatch, launched: bool): bool =
  not(latch.waiting) implies finishChooser(latch, launched).reply == latch.reply
```

## Story: Keep a local Files preview attached to its original view request

### A selection can open only in the visit that requested it

A tap uses the Files preview for PDF, JSON, XML, text, and images,
or for all files if external Open is absent. Other types can open
in another Android app. The agent's file-open leg uses selection
in Files rather than that MIME routing. Android selection authorizes
its own provider URI with zero persistable grant flags and returns
a new selection ID, name, MIME and `canRename:false`. It exposes the
URI directly only for image, audio, and video MIME families. Files
preview passes the transient selection to the shared renderer
without recording an ordinary picker Recent row.

The Files adapter captures a version of the current view at request.
Leaving or changing folder retires that version. A successful selection
for a retired version is never published as a preview. The renderer
attempts to forget only the ID returned with that stale completion.
A failed forget does not notify the abandoned view. Returning to
Files does not revive the old version. Device visibility by itself
does not invalidate a direct tap. The agent additionally requires
visible Files, a current filter snapshot for positional opens, an
unaborted request, and current storage access before dispatch. The shell samples those facts at dispatch and reply.
After opening a preview, the agent rechecks before its own success
receipt. `Open with` dispatches a separate chooser while preserving
the current local selection. A positional request with a folder at
that exact displayed position instead navigates within Files.

The model follows one unresolved preview request and its result.
The product hands that request one native promise. A returned
selection ID comes from the actual registry, and the worker
converts malformed or failed selections to refused outcomes.

```quint
type FileMimeKind = PdfFile | JsonFile | XmlFile | TextFile | ImageFile | AudioFile | VideoFile | OtherFile
pure def tapUsesFilesPreview(mimeKind: FileMimeKind, externalAvailable: bool): bool =
  not(externalAvailable) or mimeKind == PdfFile or mimeKind == JsonFile or mimeKind == XmlFile or
    mimeKind == TextFile or mimeKind == ImageFile
pure def previewCarriesRawUri(mimeKind: FileMimeKind): bool =
  mimeKind == ImageFile or mimeKind == AudioFile or mimeKind == VideoFile
type LocalFileSelection = { selected: bool, selectionId: str }
pure def nativeLocalSelection(port: FilesReadPort, authorizedId: str): LocalFileSelection =
  if (admitsFileReadPath(port) and authorizedId != "") { selected: true, selectionId: authorizedId }
  else { selected: false, selectionId: "" }
pure val authorizedIdValues = Set("", "selection-1")
pure def lawFilesSelectionUsesTheExactRegistryHandle(port: FilesReadPort, authorizedId: str): bool =
  nativeLocalSelection(port, authorizedId).selected implies
    admitsFileReadPath(port) and authorizedId != "" and nativeLocalSelection(port, authorizedId).selectionId == authorizedId
type PreviewOwner = TapPreview | AgentPreview
type PreviewStatus = NoPreviewReply | PreviewAccepted | PreviewRetired | PreviewRefused
type PreviewFacts = { visible: bool, aborted: bool, filterCurrent: bool, accessGranted: bool }
type FilesPreview = { active: bool, epoch: int, pending: bool, requestEpoch: int, owner: PreviewOwner,
  selectionId: str, forgetId: str, reply: PreviewStatus }
pure val initial: FilesPreview = { active: false, epoch: 0, pending: false, requestEpoch: 0, owner: TapPreview,
  selectionId: "", forgetId: "", reply: NoPreviewReply }
pure def agentPreviewCurrent(owner: PreviewOwner, facts: PreviewFacts): bool =
  owner != AgentPreview or (facts.visible and not(facts.aborted) and facts.filterCurrent)
pure def canEnterFilesPreview(s: FilesPreview): bool = not(s.active)
pure def enterFilesPreview(s: FilesPreview): FilesPreview = { ...s, active: true }
pure def canRetireFilesPreview(s: FilesPreview): bool = s.active
pure def retireFilesPreview(s: FilesPreview, leave: bool): FilesPreview =
  { ...s, active: not(leave), epoch: s.epoch + 1 }
pure def canBeginFilesPreview(s: FilesPreview, owner: PreviewOwner, facts: PreviewFacts): bool =
  s.active and not(s.pending) and agentPreviewCurrent(owner, facts) and (owner != AgentPreview or facts.accessGranted)
pure def beginFilesPreview(s: FilesPreview, owner: PreviewOwner, facts: PreviewFacts): FilesPreview =
  { ...s, pending: true, requestEpoch: s.epoch, owner: owner, forgetId: "", reply: NoPreviewReply }
pure def canSettleFilesPreview(s: FilesPreview): bool = s.pending
pure def settleFilesPreview(s: FilesPreview, selected: LocalFileSelection, facts: PreviewFacts): FilesPreview =
  if (not(s.active and s.requestEpoch == s.epoch and agentPreviewCurrent(s.owner, facts)))
    { ...s, pending: false, forgetId: selected.selectionId, reply: PreviewRetired }
  else if (selected.selected and selected.selectionId != "")
    { ...s, pending: false, selectionId: selected.selectionId, forgetId: "", reply: PreviewAccepted }
  else { ...s, pending: false, forgetId: "", reply: PreviewRefused }
pure val availablePreview: PreviewFacts = { visible: true, aborted: false, filterCurrent: true, accessGranted: true }
pure val factsValues = Set(availablePreview, { ...availablePreview, visible: false },
  { ...availablePreview, aborted: true }, { ...availablePreview, filterCurrent: false }, { ...availablePreview, accessGranted: false })
pure val selectedValues = Set({ selected: true, selectionId: "selection-1" }, { selected: true, selectionId: "selection-2" },
  { selected: false, selectionId: "" }, { selected: true, selectionId: "" })
pure val weight_enterFilesPreview = 9
pure val weight_beginFilesPreview = 14
pure val weight_settleFilesPreview = 14
pure val weight_retireFilesPreview = 7
pure def alwaysFilesPreviewRequestCannotComeFromTheFuture(s: FilesPreview): bool =
  s.epoch >= 0 and s.requestEpoch >= 0 and s.requestEpoch <= s.epoch
pure def stepRetiredSelectionDoesNotReplaceThePreview(before: FilesPreview, via: str, after: FilesPreview): bool =
  via == "settleFilesPreview" and after.reply == PreviewRetired implies
    after.selectionId == before.selectionId and not(after.pending)
pure def stepAcceptedFilesSelectionBelongsToItsVisit(before: FilesPreview, via: str, after: FilesPreview): bool =
  via == "settleFilesPreview" and after.reply == PreviewAccepted implies
    before.active and before.requestEpoch == before.epoch and after.selectionId != "" and after.forgetId == ""
pure def sometimesFilesVisitAcceptsSelection(s: FilesPreview): bool = s.reply == PreviewAccepted
pure def sometimesFilesRetiredSelectionIsForgotten(s: FilesPreview): bool = s.reply == PreviewRetired and s.forgetId != ""
pure def sometimesFilesCurrentSelectionRefused(s: FilesPreview): bool = s.reply == PreviewRefused
```

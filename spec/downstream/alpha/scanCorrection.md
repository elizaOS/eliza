# Reviewed scan perspective correction

Alpha `8d44dfe52` invokes `reviewScanCorrection` from its shipping
`apps/app/src/prototype/scan-document.ts`. The nested review imports
Eliza `c518127a` through `apps/app/src/browser/scan-correction.ts`.
The producer is `plugins/plugin-files/src/documents/scan-correction.ts`.
[Document scan review](../mobileDocumentScan.md) owns the parent operation,
page order, durable draft and export. Here one correction session belongs
to one selected page. Pixels and Blob bytes are effects.

## Story: Preview a perspective correction and decide whether to replace my page

### Correction admits only a supported image and a valid convex selection

The four corners are finite normalized coordinates. For each successive
corner triple the turn cross product must exceed 0.0001 in clockwise
image coordinates. Each edge length is at least 0.02 and the signed
shoelace sum must be at least 0.02, equivalent to area of 0.01. A
crossing, flipped or very small quadrilateral fails before image decode.
Accepted inputs are nonempty JPEG, PNG and WebP up to 16 MiB. Decoded
dimensions must be positive and cover at most 32 million pixels.

The producer scales the source canvas to a maximum axis of 2,048 pixels,
with a minimum axis of two. It determines output axes from averages of
opposite edge lengths, uses the same maximum and minimum, and maps each
output pixel through a perspective transform with clamped bilinear
sampling. It composites against white and encodes a JPEG at quality
0.92. The producer checks cancellation before decoding, after decoding,
at row zero and every 32 rows thereafter, before writing the output pixels and after
encoding. The decoded bitmap closes in the decode-processing scope's
finally block. The model receives the geometry predicates from the
numerical implementation and preserves its admission thresholds.

```quint
type Selection = { normalizedFour: bool, positiveTurns: bool, minimumEdges: bool, minimumArea: bool }
type ImageEvidence = { supported: bool, bytes: int, width: int, height: int }
pure val selectionValues = Set(
  { normalizedFour: true, positiveTurns: true, minimumEdges: true, minimumArea: true },
  { normalizedFour: false, positiveTurns: true, minimumEdges: true, minimumArea: true },
  { normalizedFour: true, positiveTurns: false, minimumEdges: true, minimumArea: true },
  { normalizedFour: true, positiveTurns: true, minimumEdges: false, minimumArea: true },
  { normalizedFour: true, positiveTurns: true, minimumEdges: true, minimumArea: false }
)
pure val imageValues = Set(
  { supported: true, bytes: 1024, width: 400, height: 300 },
  { supported: true, bytes: 16777216, width: 8000, height: 4000 },
  { supported: true, bytes: 16777217, width: 400, height: 300 },
  { supported: true, bytes: 1024, width: 8000, height: 4001 },
  { supported: false, bytes: 0, width: 0, height: 0 }
)
pure def allowsCorners(selection: Selection): bool =
  selection.normalizedFour and selection.positiveTurns and selection.minimumEdges and selection.minimumArea
pure def admitsDecode(selection: Selection, image: ImageEvidence, aborted: bool): bool =
  not(aborted) and allowsCorners(selection) and image.supported and image.bytes > 0 and image.bytes <= 16777216
pure def admitsDecodedImage(image: ImageEvidence): bool =
  image.width > 0 and image.height > 0 and image.width * image.height <= 32000000
pure def lawInvalidCornersStopBeforeDecode(selection: Selection, image: ImageEvidence, aborted: bool): bool =
  not(allowsCorners(selection)) implies not(admitsDecode(selection, image, aborted))
pure def lawOversizeImageStopsBeforeDecode(selection: Selection, image: ImageEvidence, aborted: bool): bool =
  image.bytes > 16777216 implies not(admitsDecode(selection, image, aborted))
pure def lawOversizeDecodedRefused(image: ImageEvidence): bool =
  image.width * image.height > 32000000 implies not(admitsDecodedImage(image))
```

### A preview belongs to its current corners and active review

The dialog starts with full-page corners. Keyboard input, dragging,
reset and successful edge detection supersede any displayed preview.
The previous preview URL is revoked. A failed detection or no suggestion
keeps the prior corners and preview. One edge-detection or correction
operation is active at a time. A generated preview can be used only
after that operation settles. Parent cancellation, hiding the document,
page retirement or Back closes the nested review, aborts its work and
releases its source and preview URLs. Back stops at this nested dialog.
Late success cannot publish into a closed or replaced review.

The model's generation binds each async publication to the live review.
The corner revision records manual changes or admitted detection. Source
and preview URL custody follow the review phases.

```quint
type CorrectionPhase = Closed | Editing | Detecting | Generating | PreviewReady
type Correction = { generation: int, phase: CorrectionPhase, corners: int, previewCorners: int,
  pageRevision: int, hasText: bool, sourceUrl: bool, previewUrl: bool }
pure val initial: Correction = { generation: 0, phase: Closed, corners: 0, previewCorners: 0,
  pageRevision: 0, hasText: false, sourceUrl: false, previewUrl: false }
pure val ownerIdValues = Set(1, 2)
pure def canLoadPage(s: Correction): bool = s.phase == Closed
pure def loadPage(s: Correction, hasText: bool): Correction =
  { ...s, pageRevision: s.pageRevision + 1, hasText: hasText }
pure def canOpenCorrection(s: Correction): bool = s.phase == Closed and s.pageRevision > 0
pure def openCorrection(s: Correction): Correction =
  { ...s, phase: Editing, generation: s.generation + 1, corners: 1, previewCorners: 0, sourceUrl: true }
pure def controlsReady(s: Correction): bool = s.phase == Editing or s.phase == PreviewReady
pure def clearPreview(nextPhase: CorrectionPhase, s: Correction): Correction =
  { ...s, phase: nextPhase, previewCorners: 0, previewUrl: false }
pure def canChangeCorners(s: Correction): bool = controlsReady(s)
pure def changeCorners(s: Correction): Correction =
  clearPreview(Editing, { ...s, corners: s.corners + 1 })
pure def canDetectCorners(s: Correction): bool = controlsReady(s)
pure def detectCorners(s: Correction): Correction = { ...s, phase: Detecting }
pure def canSettleDetection(s: Correction, ownerId: int): bool = s.phase == Detecting and ownerId == s.generation
pure def settleDetection(s: Correction, ownerId: int, found: bool): Correction =
  if (found) clearPreview(Editing, { ...s, corners: s.corners + 1 })
  else { ...s, phase: if (s.previewUrl) PreviewReady else Editing }
pure def canGeneratePreview(s: Correction): bool = controlsReady(s)
pure def generatePreview(s: Correction): Correction = clearPreview(Generating, s)
pure def canSettlePreview(s: Correction, ownerId: int): bool = s.phase == Generating and ownerId == s.generation
pure def settlePreview(s: Correction, ownerId: int, produced: bool): Correction =
  if (produced) { ...s, phase: PreviewReady, previewUrl: true, previewCorners: s.corners }
  else { ...s, phase: Editing }
pure def canCancelCorrection(s: Correction): bool = s.phase != Closed
pure def closeReview(nextPhase: CorrectionPhase, s: Correction): Correction =
  clearPreview(nextPhase, { ...s, sourceUrl: false, corners: 0 })
pure def cancelCorrection(s: Correction): Correction = closeReview(Closed, s)
pure def alwaysLiveReviewOwnsSource(s: Correction): bool = s.sourceUrl == (s.phase != Closed)
pure def alwaysPreviewOwnsCurrentCorners(s: Correction): bool =
  if (s.previewUrl) (s.phase == PreviewReady or s.phase == Detecting) and
    s.previewCorners == s.corners and s.corners > 0
  else s.phase != PreviewReady and s.previewCorners == 0
pure def alwaysLiveReviewHasPage(s: Correction): bool =
  s.generation >= 0 and s.pageRevision >= 0 and (s.phase != Closed implies s.generation > 0 and s.pageRevision > 0 and s.corners > 0)
pure def stepRetireReleasesUrls(before: Correction, via: str, after: Correction): bool =
  via == "cancelCorrection" implies not(after.sourceUrl or after.previewUrl)
pure def stepCornerEditRevokesPreview(before: Correction, via: str, after: Correction): bool =
  via == "changeCorners" implies not(after.previewUrl)
pure def sometimesPreviewReady(s: Correction): bool = s.phase == PreviewReady
pure def sometimesDetectingWithPreview(s: Correction): bool = s.phase == Detecting and s.previewUrl
pure val weight_openCorrection = 2
pure val weight_generatePreview = 3
pure val weight_settlePreview = 3
pure val weight_detectCorners = 2
```

### Only adoption can replace the selected page and discard its text

Use corrected page returns the preview at the exact current corner
revision to the still-active parent operation. The parent first checks
its abort signal and the resulting total document limit of 64 MiB.
The parent also checks the replacement byte size, accepted image type
and current editable page slot.
Only a successful replacement assigns a new page identity and clears
that page's old reviewed text. Other page identities, bytes and text
stay in the parent's ordered snapshot. Refusal closes the nested review
and leaves the original selected page and text in the parent. Cancellation
and preview generation never write the document or draft.

```quint
pure def replacementAllowed(parentCurrent: bool, pageAdmitted: bool, completeBytes: int): bool =
  parentCurrent and pageAdmitted and completeBytes > 0 and completeBytes <= 67108864
pure val completeBytesValues = Set(0, 10, 67108864, 67108865)
pure def canAdoptCorrection(s: Correction): bool = s.phase == PreviewReady and s.previewUrl and s.previewCorners == s.corners
pure def adoptCorrection(s: Correction, parentCurrent: bool, pageAdmitted: bool, completeBytes: int): Correction = {
  val closed = closeReview(Closed, s)
  if (replacementAllowed(parentCurrent, pageAdmitted, completeBytes))
    { ...closed, pageRevision: s.pageRevision + 1, hasText: false }
  else closed
}
pure def stepOnlyAdoptionReplacesPage(before: Correction, via: str, after: Correction): bool =
  via != "loadPage" and via != "adoptCorrection" implies
    after.pageRevision == before.pageRevision and after.hasText == before.hasText
pure def stepReplacementDropsOnlySelectedText(before: Correction, via: str, after: Correction): bool =
  via == "adoptCorrection" and after.pageRevision != before.pageRevision implies not(after.hasText)
pure def lawStaleParentCannotReplace(completeBytes: int): bool = not(replacementAllowed(false, true, completeBytes))
pure def lawOversizeReplacementPreservesOriginal(completeBytes: int): bool =
  completeBytes > 67108864 implies not(replacementAllowed(true, true, completeBytes))
pure def sometimesAdoptableText(s: Correction): bool = canAdoptCorrection(s) and s.hasText
```

The exact Alpha fixtures are `test/browser/scan-correction.spec.ts` and
`test/browser/scan-text-draft.spec.ts`. They run the actual renderer and
producer on Chromium, including perspective output, invalid corners,
cancellation during decode, URL cleanup and selected-page text ownership.
The numerical homography, encoded JPEG bytes and installed WebView can
be checked through those platform boundaries independently of the model.

# Alpha local OCR image and worker custody

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` calls
`plugins/plugin-files/src/documents/local-ocr.ts` from Eliza
`c518127a025ab173874af9c7d304f26b25213b0d`. The installed Alpha wrapper
selects `/ocr/worker.min.js`, `/ocr/` and English. Scans and browser
content questions use the same recognizer. [Scan review](../mobileDocumentScan.md)
owns the document revision and [searchable PDF](./searchableScanPdf.md)
owns normalized text placement.

## Story: Read the selected image on device and stop the worker when I cancel

### Image admission is bounded before recognition and every decoded bitmap closes

A pre-aborted signal refuses before a worker is created. Use a JPEG,
PNG or WebP blob from one byte through 16 MiB. Creating the worker
precedes asynchronous bitmap decoding. A zero dimension or more than
32 million decoded pixels refuses conversion. Preserve the aspect ratio
with a maximum side of 2,048, using rounded dimensions with a minimum
of one. The canvas uses a white background and requests PNG bytes. A
missing drawing context or output fails explicitly. Close the decoded
bitmap even if drawing or conversion throws. Bitmap decoding, drawing,
rescaling and blob allocation are Effect port results.

```quint
type OcrImageType = OcrJpeg | OcrPng | OcrWebp | OtherOcrImage
pure def admitsOcrBlob(mime: OcrImageType, blobBytes: int, aborted: bool): bool =
  mime != OtherOcrImage and blobBytes > 0 and blobBytes <= 16777216 and not(aborted)
pure def admitsOcrBitmap(hasWidth: bool, hasHeight: bool, pixels: int): bool =
  hasWidth and hasHeight and pixels > 0 and pixels <= 32000000
pure def lawOversizeOcrBlobDoesNotStart(mime: OcrImageType, blobBytes: int, aborted: bool): bool =
  blobBytes > 16777216 implies not(admitsOcrBlob(mime,blobBytes,aborted))
pure def lawUnboundedOcrBitmapDoesNotConvert(hasWidth: bool, hasHeight: bool, pixels: int): bool =
  pixels > 32000000 implies not(admitsOcrBitmap(hasWidth,hasHeight,pixels))
pure val blobBytesValues = Set(0,1,16777216,16777217)
pure val pixelsValues = Set(0,1,32000000,32000001)
```

### One exact worker reply advances the next local OCR action

Use one worker and one pending request at a time. The request sequence
is `load`, `loadLanguage`, `initialize` and `recognize`, with increasing
decimal job IDs beginning at one. Load uses the local core path and
LSTM only. Language load uses the local language path, gzip, no cache
and LSTM only. Initialization uses OEM 1. Recognition takes the prepared
image bytes and requests text, with blocks only for layout review.

Worker ID, job ID and action must match the live request. A finite
progress value and string status are reported with progress clamped
between zero and one. Progress leaves the request pending. An exact
resolve clears it once and advances the chain. An exact reject fails
the reader. Worker errors, message errors, a failed post, cancellation
or return close the worker once and clear the pending request. Results
from an already retired worker or completed job are ignored. The
constructing caller supplies the worker identity and effect outcomes.

```quint
type OcrStep = DecodeOcrImage | LoadOcrEngine | LoadOcrLanguage | InitializeOcr | RecognizeOcr | RecognizedOcr | EndedOcr
type OcrReplyKind = OcrProgressReply | OcrResolveReply | OcrRejectReply | OtherOcrReply
type OcrReply = { sameWorker: bool, jobNumber: int, actionName: OcrStep, kind: OcrReplyKind,
  hasProgressStatus: bool, progressFinite: bool }
type OcrJob = { phase: OcrStep, jobNumber: int, workerClosed: bool, exactResult: bool }
pure val initial: OcrJob = { phase: DecodeOcrImage, jobNumber: 0, workerClosed: false, exactResult: false }
pure def canPrepareOcrImage(s: OcrJob, ready: bool): bool =
  s.phase == DecodeOcrImage and ready
pure def prepareOcrImage(s: OcrJob, ready: bool): OcrJob =
  { ...s, phase: LoadOcrEngine, jobNumber: 1 }
pure def ocrStepWaiting(phase: OcrStep): bool =
  phase == LoadOcrEngine or phase == LoadOcrLanguage or phase == InitializeOcr or phase == RecognizeOcr
pure def matchingOcrReply(s: OcrJob, reply: OcrReply): bool =
  ocrStepWaiting(s.phase) and not(s.workerClosed) and reply.sameWorker and
    reply.jobNumber == s.jobNumber and reply.actionName == s.phase
pure def exposesOcrProgress(s: OcrJob, reply: OcrReply): bool =
  matchingOcrReply(s,reply) and reply.kind == OcrProgressReply and reply.hasProgressStatus and reply.progressFinite
pure def canSettleOcrReply(s: OcrJob, reply: OcrReply): bool =
  matchingOcrReply(s,reply) and (reply.kind == OcrResolveReply or reply.kind == OcrRejectReply)
pure def settleOcrReply(s: OcrJob, reply: OcrReply): OcrJob =
  if (reply.kind == OcrRejectReply) { ...s, phase: EndedOcr, workerClosed: true }
  else if (s.phase == LoadOcrEngine) { ...s, phase: LoadOcrLanguage, jobNumber: 2 }
  else if (s.phase == LoadOcrLanguage) { ...s, phase: InitializeOcr, jobNumber: 3 }
  else if (s.phase == InitializeOcr) { ...s, phase: RecognizeOcr, jobNumber: 4 }
  else { ...s, phase: RecognizedOcr, exactResult: true }
pure def canEndOcrWorker(s: OcrJob): bool = not(s.workerClosed)
pure def endOcrWorker(s: OcrJob): OcrJob =
  { ...s, phase: EndedOcr, workerClosed: true }
pure def alwaysOcrWorkerCustody(s: OcrJob): bool =
  (s.workerClosed iff s.phase == EndedOcr) and
    (s.phase == RecognizedOcr implies s.exactResult) and
    (s.exactResult implies (s.phase == RecognizedOcr or s.phase == EndedOcr)) and
    (s.phase == DecodeOcrImage implies s.jobNumber == 0) and
    (s.phase == LoadOcrEngine implies s.jobNumber == 1) and
    (s.phase == LoadOcrLanguage implies s.jobNumber == 2) and
    (s.phase == InitializeOcr implies s.jobNumber == 3) and
    ((s.phase == RecognizeOcr or s.phase == RecognizedOcr or s.exactResult) implies s.jobNumber == 4)
pure def stepClosedOcrNeverResumes(before: OcrJob, after: OcrJob): bool =
  before.workerClosed implies after.workerClosed and after.jobNumber == before.jobNumber and after.exactResult == before.exactResult
pure def lawForeignOcrReplyCannotAdvance(s: OcrJob, reply: OcrReply): bool =
  not(reply.sameWorker) implies not(canSettleOcrReply(s,reply) or exposesOcrProgress(s,reply))
pure def sometimesWorkerRecognizes(s: OcrJob): bool = s.phase == RecognizedOcr
pure def sometimesWorkerClosesDuringStartup(s: OcrJob): bool = s.workerClosed and s.jobNumber == 1
pure val loadReply: OcrReply = { sameWorker: true, jobNumber: 1, actionName: LoadOcrEngine,
  kind: OcrResolveReply, hasProgressStatus: false, progressFinite: false }
pure val replyValues = Set(loadReply, { ...loadReply, jobNumber: 2, actionName: LoadOcrLanguage },
  { ...loadReply, jobNumber: 3, actionName: InitializeOcr }, { ...loadReply, jobNumber: 4, actionName: RecognizeOcr },
  { ...loadReply, kind: OcrRejectReply }, { ...loadReply, sameWorker: false },
  { ...loadReply, kind: OcrProgressReply, hasProgressStatus: true, progressFinite: true })
pure val weight_settleOcrReply = 8
```

### Completed OCR uses validated text and positions and stays scoped to its review

The result must contain a string of at most 100,000 UTF-16 units and
finite confidence. Return trimmed text with its reported confidence.
Layout mode also requires null or array blocks. Flatten each block,
paragraph and line in order. Each line has a string and bounding box.
Normalize coordinates against the actual canvas dimensions, trim the
line and validate the resulting page layer. An empty layer is valid
when blocks are null. The image-only result carries no line layer.

The recognizer stops accepting worker messages as soon as it closes.
An exact recognition message that already resolved can still be decoded
if cancellation occurs before the JavaScript continuation. The scan
review rechecks its own abort signal and current document before
presenting that result. The model distinguishes worker settlement from
the review's authority to display it.

```quint
type OcrResultFacts = { exactMessage: bool, textString: bool, textUnits: int, confidenceFinite: bool,
  hasLayout: bool, blocksAdmitted: bool, lineLayerAdmitted: bool, reviewCurrent: bool, reviewAborted: bool }
pure def admittedOcrResult(facts: OcrResultFacts): bool =
  facts.exactMessage and facts.textString and facts.textUnits >= 0 and facts.textUnits <= 100000 and
    facts.confidenceFinite and (not(facts.hasLayout) or (facts.blocksAdmitted and facts.lineLayerAdmitted))
pure def exposesReviewedOcr(facts: OcrResultFacts): bool =
  admittedOcrResult(facts) and facts.reviewCurrent and not(facts.reviewAborted)
pure def lawRetiredOcrReviewCannotDisplay(facts: OcrResultFacts): bool =
  (not(facts.reviewCurrent) or facts.reviewAborted) implies not(exposesReviewedOcr(facts))
pure val cleanOcrResult: OcrResultFacts = { exactMessage: true, textString: true, textUnits: 30, confidenceFinite: true,
 hasLayout: true, blocksAdmitted: true, lineLayerAdmitted: true, reviewCurrent: true, reviewAborted: false }
pure val factsValues = Set(cleanOcrResult, { ...cleanOcrResult, textUnits: 100001 },
 { ...cleanOcrResult, confidenceFinite: false }, { ...cleanOcrResult, reviewAborted: true },
 { ...cleanOcrResult, hasLayout: false, blocksAdmitted: false }, { ...cleanOcrResult, lineLayerAdmitted: false })
```

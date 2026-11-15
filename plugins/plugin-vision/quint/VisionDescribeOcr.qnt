// The describe augmenter gives the coord-OCR service only PNG bytes, and when
// it cannot produce them it skips OCR with the conversion failure.
module VisionDescribeOcr {
  // image: 0 PNG, 1 JPEG, 2 bytes no decoder reads.
  // backend: 0 the image backend loads, 1 it fails to load.
  // ocrInput: -1 OCR not called, 0 PNG bytes, 1 JPEG bytes, 2 unreadable bytes.
  // reason: 0 none, 1 conversion failed, 2 backend unavailable, 3 the coord
  // adapter rejected the PNG header.
  var image: int
  var hasText: bool
  var backend: int
  var phase: int
  var ocrInput: int
  var passThrough: bool
  var reason: int
  var ocrText: bool

  action init = {
    nondet chosenImage = Set(0, 1, 2).oneOf()
    nondet chosenText = Set(true, false).oneOf()
    nondet chosenBackend = Set(0, 1).oneOf()
    all {
      image' = chosenImage, hasText' = chosenText, backend' = chosenBackend,
      phase' = 0, ocrInput' = -1, passThrough' = false, reason' = 0,
      ocrText' = false
    }
  }
  // toOcrPngBytes: a PNG passes through unchanged; other bytes are re-encoded
  // as PNG, or the backend load or decode failure ends OCR with its reason.
  action convert = all {
    phase == 0, phase' = 1,
    image' = image, hasText' = hasText, backend' = backend,
    ocrInput' = if (image == 0 or (image == 1 and backend == 0)) 0 else -1,
    passThrough' = (image == 0),
    reason' = if (image == 0 or (image == 1 and backend == 0)) 0
      else if (backend == 1) 2 else 1,
    ocrText' = ocrText
  }
  // RapidOcrCoordAdapter reads the PNG header, then the recognizer reads text.
  action ocr = all {
    phase == 1, phase' = 2,
    image' = image, hasText' = hasText, backend' = backend,
    ocrInput' = ocrInput, passThrough' = passThrough,
    reason' = if (ocrInput >= 1) 3 else reason,
    ocrText' = (ocrInput == 0 and hasText)
  }
  action stay = all {
    phase == 2, phase' = phase,
    image' = image, hasText' = hasText, backend' = backend,
    ocrInput' = ocrInput, passThrough' = passThrough, reason' = reason,
    ocrText' = ocrText
  }
  action step = any { convert, ocr, stay }

  pure def readable(i: int, b: int): bool = i == 0 or (i == 1 and b == 0)

  val OcrReceivesOnlyPng = ocrInput <= 0
  val PngPassesUnchanged =
    phase == 0 or image != 0 or (ocrInput == 0 and passThrough)
  val ReadableImageKeepsText =
    phase != 2 or not(hasText and readable(image, backend)) or ocrText
  val FailureKeepsItsReason =
    phase == 0 or (
      if (readable(image, backend)) reason == 0
      else ocrInput == -1 and reason == (if (backend == 1) 2 else 1)
    )
}

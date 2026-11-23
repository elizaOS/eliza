# Native inference

[Local inference](../localInference/) owns installed models. The [Android inference host](../os/agentService/inference.md) owns its process, frame and operation limits. This package covers the native model host adapters and OCR output boundary.

## Story: Use a native engine only for an admitted model or recognized image

> As the person, I want inference tied to the reviewed installed model, and OCR results that retain the engine's real uncertainty.

### Native inference work needs a current model assigned to its operation

The shell binds the actual artifact digest, catalog signature, device fit and runtime host support. A model lease cannot migrate from an unloaded or replaced runtime to a newer engine.

```quint
type ModelPurpose = NativeChat | NativeEmbedding | NativeSpeech | NativeTranscription
type NativeModelLease = { digest: str, purpose: ModelPurpose, generation: int, signatureVerified: bool, fitsDevice: bool, loaded: bool }
pure def mayUseNativeModel(lease: NativeModelLease, purpose: ModelPurpose, generation: int): bool =
  lease.digest != "" and lease.purpose == purpose and lease.generation == generation and
  lease.signatureVerified and lease.fitsDevice and lease.loaded
pure def lawUnsignedModelCannotRun(lease: NativeModelLease, purpose: ModelPurpose, generation: int): bool =
  not(lease.signatureVerified) implies not(mayUseNativeModel(lease, purpose, generation))
```

### OCR confidence and bounds stay within the recognized image

```quint
type RecognizedElement = { text: str, leftPx: int, topPx: int, rightPx: int, bottomPx: int, confidencePercent: int }
pure def validRecognizedElement(element: RecognizedElement, widthPx: int, heightPx: int): bool =
  element.text != "" and element.confidencePercent >= 0 and element.confidencePercent <= 100 and
  element.leftPx >= 0 and element.topPx >= 0 and element.rightPx <= widthPx and element.bottomPx <= heightPx and
  element.leftPx < element.rightPx and element.topPx < element.bottomPx
type TextRead = AcceptedText(RecognizedElement) | InvalidText
pure def normalizeRecognizedElement(element: RecognizedElement, widthPx: int, heightPx: int): TextRead =
  if (validRecognizedElement(element, widthPx, heightPx)) AcceptedText({ text: element.text, leftPx: element.leftPx, topPx: element.topPx, rightPx: element.rightPx, bottomPx: element.bottomPx, confidencePercent: element.confidencePercent }) else InvalidText
pure def lawAcceptedOcrRetainsConfidence(element: RecognizedElement, widthPx: int, heightPx: int): bool =
  validRecognizedElement(element, widthPx, heightPx) implies
  normalizeRecognizedElement(element, widthPx, heightPx) == AcceptedText({ text: element.text, leftPx: element.leftPx, topPx: element.topPx, rightPx: element.rightPx, bottomPx: element.bottomPx, confidencePercent: element.confidencePercent })
pure val leaseValues = Set(
  { digest: "catalog-digest", purpose: NativeEmbedding, generation: 1, signatureVerified: true, fitsDevice: true, loaded: true },
  { digest: "unverified-copy", purpose: NativeEmbedding, generation: 1, signatureVerified: false, fitsDevice: true, loaded: true },
  { digest: "catalog-digest", purpose: NativeChat, generation: 2, signatureVerified: true, fitsDevice: false, loaded: false })
pure val elementValues = Set(
  { text: "Receipt", leftPx: 1, topPx: 2, rightPx: 80, bottomPx: 21, confidencePercent: 76 },
  { text: "Receipt", leftPx: 1, topPx: 2, rightPx: 80, bottomPx: 21, confidencePercent: 101 },
  { text: "", leftPx: 1, topPx: 2, rightPx: 80, bottomPx: 21, confidencePercent: 73 })
pure val widthPxValues = Set(0, 79, 80, 320)
pure val heightPxValues = Set(0, 20, 21, 240)
pure val generationValues = Set(0, 1, 2)
```

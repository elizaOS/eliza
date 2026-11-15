# On-device image text recognition

`plugin-vision`'s describe augmenter adds on-device text recognition to an
image description. Recognition runs locally in the device's coordinate
OCR service, bounded to one image per call and isolated from the network;
it receives only PNG bytes. This spec ports the producer's
`VisionDescribeOcr` model. Image descriptions themselves belong to the
agent's model providers.

## Story: Read the text in a picture on the device

> As the person, I want the text in a photo I share read on the phone
> itself, and to be told why when it could not be read.

### Recognition receives only PNG bytes, and a failed conversion skips it with its reason

A PNG passes to recognition unchanged. A JPEG is re-encoded as PNG when
the image backend loads. When the backend cannot load, recognition is
skipped with backend unavailable; bytes no decoder reads are skipped with
conversion failed. A readable image with text always yields recognized
text, and a skipped image reaches recognition with no bytes at all.

```quint
type SharedImage = PngImage | JpegImage | UnreadableImage
type OcrInput = NoOcrInput | PngBytes
type OcrSkip = NotSkipped | ConversionFailed | BackendUnavailable
type OcrRun = { input: OcrInput, passThrough: bool, skip: OcrSkip, recognizedText: bool }
pure def readableImage(image: SharedImage, backendLoads: bool): bool = image == PngImage or (image == JpegImage and backendLoads)
pure def describeOcr(image: SharedImage, backendLoads: bool, hasText: bool): OcrRun =
  if (readableImage(image, backendLoads)) { input: PngBytes, passThrough: image == PngImage, skip: NotSkipped, recognizedText: hasText }
  else { input: NoOcrInput, passThrough: false, skip: if (not(backendLoads)) BackendUnavailable else ConversionFailed, recognizedText: false }
pure def lawPngPassesUnchanged(backendLoads: bool, hasText: bool): bool =
  describeOcr(PngImage, backendLoads, hasText).passThrough and describeOcr(PngImage, backendLoads, hasText).input == PngBytes
pure def lawReadableImageKeepsText(image: SharedImage, backendLoads: bool): bool =
  readableImage(image, backendLoads) implies describeOcr(image, backendLoads, true).recognizedText
pure def lawFailureKeepsItsReason(image: SharedImage, backendLoads: bool, hasText: bool): bool =
  not(readableImage(image, backendLoads)) implies describeOcr(image, backendLoads, hasText).input == NoOcrInput and
    describeOcr(image, backendLoads, hasText).skip == (if (backendLoads) ConversionFailed else BackendUnavailable)
```

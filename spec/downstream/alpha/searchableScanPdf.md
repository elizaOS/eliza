# Alpha reviewed searchable PDF

AlphaPhone `8d44dfe52b0a6e2f3462b5da85dd3f8037518f43` uses
`plugins/plugin-files/src/documents/{scan-pdf,scan-text-layer}.ts`
from Eliza `c518127a025ab173874af9c7d304f26b25213b0d`.
[Local OCR](./localOcr.md) supplies the optional initial positions.
[Scan review](../mobileDocumentScan.md) owns edits and the exact ordered
export draft. This specification owns the PDF conversion and admission
before the destination is asked to write.

## Story: Save the reviewed text beside the image of its own page

### The layer keeps validated top-left positions and complete reviewed lines

A layer has at most 2,000 records and at most 100,000 total UTF-16
units. Each record contains string text of at most 4,000 units.
Reject CR, LF, NUL through backspace and vertical tab through U+001F,
allowing ordinary tab. Position numbers are finite. Origins are
nonnegative, width and height positive, and right and bottom edges
at most 1.000001. The values refer to the unchanged ordered image
snapshot. Decimal validation and exact edges are computed by the
JavaScript codec, with their verdict represented here. Do not admit
an invalid line by clamping or trimming it. The OCR producer trims
its own initial strings before exposing them. Later person edits are
the strings the PDF builder validates and uses.

```quint
type PdfLineEvidence = { isLine: bool, isText: bool, textUnits: int, cleanText: bool, finitePosition: bool,
  nonnegativeOrigin: bool, positiveSize: bool, fitsRight: bool, fitsBottom: bool }
pure def pdfLineAdmitted(line: PdfLineEvidence): bool =
  line.isLine and line.isText and line.textUnits >= 0 and line.textUnits <= 4000 and line.cleanText and
    line.finitePosition and line.nonnegativeOrigin and line.positiveSize and line.fitsRight and line.fitsBottom
pure def pdfLayerAdmitted(isArray: bool, lineCount: int, textUnits: int, allLinesAdmitted: bool): bool =
  isArray and lineCount >= 0 and lineCount <= 2000 and textUnits >= 0 and textUnits <= 100000 and allLinesAdmitted
pure def lawPdfLayerKeepsEveryLine(isArray: bool, lineCount: int, textUnits: int, allLinesAdmitted: bool): bool =
  pdfLayerAdmitted(isArray,lineCount,textUnits,allLinesAdmitted) implies
    allLinesAdmitted and lineCount <= 2000 and textUnits <= 100000
pure def lawPdfLineCannotLeaveBounds(line: PdfLineEvidence): bool =
  pdfLineAdmitted(line) implies line.nonnegativeOrigin and line.positiveSize and line.fitsRight and line.fitsBottom
pure val checkedLine: PdfLineEvidence = { isLine: true, isText: true, textUnits: 0, cleanText: true, finitePosition: true,
  nonnegativeOrigin: true, positiveSize: true, fitsRight: true, fitsBottom: true }
pure val lineValues = Set(checkedLine, { ...checkedLine, textUnits: 4000 }, { ...checkedLine, textUnits: 4001 },
  { ...checkedLine, fitsRight: false }, { ...checkedLine, positiveSize: false }, { ...checkedLine, cleanText: false })
pure val lineCountValues = Set(0,1,2000,2001)
pure val textUnitsValues = Set(0,4000,4001,100000,100001)
```

### Conversion keeps ordered image pages and only reviewed text becomes searchable

Copy the image array and each validated line record synchronously, before
the async PDF library loads. Image-only output has no text layer. A
searchable export has one validated layer per image in the same order,
with each string encodable in the selected Helvetica standard font.
An unsupported string refuses before preparing image pages. Empty
layer arrays for a page and blank line records are allowed. Blank text,
or text with zero natural width, contributes no positioned operator.

Require one through 20 images and at most 64 MiB total. Apply the
same supported image formats, per-image 16 MiB limit, 32 million
pixel bound and 2,048 pixel maximum side as local OCR. Each bitmap
is closed after conversion. The canvas encodes JPEG at quality 0.9.
Pages are A4 portrait or landscape based on the converted image,
with a 24-point margin. Fit and center the image. The text box uses
the fitted image width and height, converts top-left to bottom-left
with one minus top and height, and squeezes character spacing to
the reported line width. Graphics scope contains the invisible text
operator. Searchable and image-only output render the same image pixels. Each text
operator belongs to its reviewed page. Codec precision, font
measurement and the canvas and PDF effects are supplied by the ports.

```quint
type PdfInput = { imageCount: int, totalImageBytes: int, layersSupplied: bool, layerCount: int,
  layersAdmitted: bool, allTextEncodable: bool, allImagesAdmitted: bool, aborted: bool }
pure def pdfInputAdmitted(bundle: PdfInput): bool =
  not(bundle.aborted) and bundle.imageCount >= 1 and bundle.imageCount <= 20 and
    bundle.totalImageBytes >= 0 and bundle.totalImageBytes <= 67108864 and bundle.allImagesAdmitted and
    (not(bundle.layersSupplied) or
      (bundle.layerCount == bundle.imageCount and bundle.layersAdmitted and bundle.allTextEncodable))
pure def placesPdfText(layersSupplied: bool, matchedPage: bool, contentNonblank: bool, hasNaturalWidth: bool): bool =
  layersSupplied and matchedPage and contentNonblank and hasNaturalWidth
pure def lawSearchablePdfNeedsEveryPage(bundle: PdfInput): bool =
  (pdfInputAdmitted(bundle) and bundle.layersSupplied) implies bundle.layerCount == bundle.imageCount and
    bundle.layersAdmitted and bundle.allTextEncodable
pure def lawPdfNeverUsesDifferentPage(layersSupplied: bool, contentNonblank: bool, hasNaturalWidth: bool): bool =
  not(placesPdfText(layersSupplied,false,contentNonblank,hasNaturalWidth))
pure val twoPagePdf: PdfInput = { imageCount: 2, totalImageBytes: 12, layersSupplied: true, layerCount: 2,
  layersAdmitted: true, allTextEncodable: true, allImagesAdmitted: true, aborted: false }
pure val bundleValues = Set(twoPagePdf, { ...twoPagePdf, layerCount: 1 },
  { ...twoPagePdf, allTextEncodable: false }, { ...twoPagePdf, layersSupplied: false, allTextEncodable: false },
  { ...twoPagePdf, totalImageBytes: 67108864 }, { ...twoPagePdf, totalImageBytes: 67108865 },
  { ...twoPagePdf, imageCount: 0 }, { ...twoPagePdf, imageCount: 21 }, { ...twoPagePdf, aborted: true })
```

### A conversion refusal occurs before a write request

Observe abort before construction, after library load, before each image,
during position placement and after serialization. The output must fit
8 MiB. Alpha encodes the finalized bytes for the destination bridge
and checks the signal again immediately before requesting the write.
Conversion errors leave retry available. A thrown export call is
unconfirmed. The resolved statuses cancelled, failed, unavailable or
too-large are the only statuses permitting retry.
Leaving after dispatch keeps the effect unconfirmed unless a settled
receipt was already adopted. Shared document-picker and selected-grant
custody remain outside this conversion.

```quint
type PdfExportEvidence = PdfCancelled | PdfFailed | PdfUnavailable | PdfTooLarge | PdfRequested | PdfExported | PdfUnverified | PdfOtherOutcome
pure def pdfReadyForDestination(converted: bool, outputBytes: int, aborted: bool): bool =
  converted and outputBytes >= 0 and outputBytes <= 8388608 and not(aborted)
pure def pdfExportRetryable(receipt: PdfExportEvidence): bool =
  receipt == PdfCancelled or receipt == PdfFailed or receipt == PdfUnavailable or receipt == PdfTooLarge
pure def lawUnfinishedPdfCannotRequest(outputBytes: int, aborted: bool): bool =
  not(pdfReadyForDestination(false,outputBytes,aborted))
pure def lawUncertainPdfDoesNotRetry(receipt: PdfExportEvidence): bool =
  (receipt == PdfRequested or receipt == PdfExported or receipt == PdfUnverified or receipt == PdfOtherOutcome) implies not(pdfExportRetryable(receipt))
pure val outputBytesValues = Set(0,1,8388608,8388609)
```

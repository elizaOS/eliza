# Scanned and recognized images

Local recognition, page correction, scan drafts and searchable PDFs admit
the same images: a JPEG, PNG or WebP of one byte through 16 MiB, decoding
to positive dimensions of at most 32 million pixels, scaled down to at
most 2,048 pixels on its longer side. A page set holds 1 through 20 such
pages of at most 64 MiB together. [Local OCR](./localOcr.md),
[correction](./scan/correction.md), [scan review](./scan/review.md),
[drafts](./scan/drafts.md) and [searchable PDFs](./scan/searchablePdf.md)
import these bounds.

## Story: Refuse an image before it can exhaust the device

> As a person scanning or recognizing a page, I want an oversized or
> unreadable image refused before it is decoded, so that one bad file never
> stalls or crashes the app.

### An image is admitted only within its byte, pixel and page bounds

```quint
pure val maxImageBytes = 16777216
pure val maxDecodedPixels = 32000000
pure val maxLongSide = 2048
pure val maxPages = 20
pure val maxPageSetBytes = 67108864
pure def admitsImageBytes(supported: bool, imageBytes: int): bool = supported and imageBytes > 0 and imageBytes <= maxImageBytes
pure def admitsDecodedPixels(width: int, height: int): bool = width > 0 and height > 0 and width * height <= maxDecodedPixels
pure def admitsPageSet(pageCount: int, totalBytes: int): bool = pageCount >= 1 and pageCount <= maxPages and totalBytes > 0 and totalBytes <= maxPageSetBytes
pure def lawOversizeImageRefused(supported: bool, imageBytes: int): bool = imageBytes > maxImageBytes implies not(admitsImageBytes(supported, imageBytes))
pure def lawOversizeDecodedImageRefused(width: int, height: int): bool = width * height > maxDecodedPixels implies not(admitsDecodedPixels(width, height))
pure def lawOversizePageSetRefused(pageCount: int, totalBytes: int): bool =
  (pageCount > maxPages or totalBytes > maxPageSetBytes) implies not(admitsPageSet(pageCount, totalBytes))
pure val imageBytesValues = Set(0, 1, 16777216, 16777217)
pure val widthValues = Set(0, 400, 8000)
pure val heightValues = Set(0, 300, 4000, 4001)
pure val pageCountValues = Set(0, 1, 20, 21)
pure val totalBytesValues = Set(0, 616, 67108864, 67108865)
```

### A decoded image is scaled down to its longer-side bound, never up

```quint
pure def longSide(width: int, height: int): int = if (width >= height) width else height
pure def scaledLongSide(width: int, height: int): int = if (longSide(width, height) > maxLongSide) maxLongSide else longSide(width, height)
pure def lawScaledImageFitsLongSide(width: int, height: int): bool =
  scaledLongSide(width, height) <= maxLongSide and (longSide(width, height) <= maxLongSide implies scaledLongSide(width, height) == longSide(width, height))
```

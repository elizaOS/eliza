# Computer use observation, deduplication, and coordinate safety

## Story: Minimize vision tokens while keeping coordinates and history strictly bounded

> As an agent controlling a computer, I want unchanged screenshots deduplicated via dHash distance, text-first planning to skip image uploads when OCR/AX already ground the target, display coordinates validated within bounds, and observation history strictly bounded.

### Change detection, image attachment policy, pixel budgets, and coordinate bounds obey pure safety laws

A frame is treated as changed only when its dHash Hamming distance meets or exceeds the configured threshold. Under `AttachOnEscalation`, pixels are attached only when text/OCR/AX grounding fails or a strict retry is triggered. Coordinates are checked against display dimensions and clamped cleanly inside bounds.

```quint
type ImageAttachPolicy = AttachAlways | AttachOnEscalation | AttachNever

pure def frameChanged(hammingDistance: int, threshold: int): bool =
  hammingDistance >= threshold

pure def shouldReuseCachedPlan(hammingDistance: int, threshold: int, hasCachedPlan: bool): bool =
  hasCachedPlan and not(frameChanged(hammingDistance, threshold))

pure def shouldAttachImage(policy: ImageAttachPolicy, groundedByText: bool, strictRetry: bool): bool =
  match policy {
    | AttachAlways => true
    | AttachNever => false
    | AttachOnEscalation => not(groundedByText) or strictRetry
  }

pure def withinPixelBudget(width: int, height: int, maxPixels: int): bool =
  width > 0 and height > 0 and maxPixels > 0 and width * height <= maxPixels

pure def estimateImageTokens(width: int, height: int, pixelsPerToken: int): int =
  if (width <= 0 or height <= 0 or pixelsPerToken <= 0) 0
  else (width * height + pixelsPerToken - 1) / pixelsPerToken

pure def pointInDisplayBounds(x: int, y: int, width: int, height: int): bool =
  width > 0 and height > 0 and x >= 0 and y >= 0 and x < width and y < height

pure def clampCoord(value: int, limit: int): int =
  if (limit <= 0) 0
  else if (value < 0) 0
  else if (value >= limit) limit - 1
  else value

pure def lawAttachNeverSkipsImage(groundedByText: bool, strictRetry: bool): bool =
  not(shouldAttachImage(AttachNever, groundedByText, strictRetry))

pure def lawAttachAlwaysSendsImage(groundedByText: bool, strictRetry: bool): bool =
  shouldAttachImage(AttachAlways, groundedByText, strictRetry)

pure def lawEscalationSkipsWhenGrounded(strictRetry: bool): bool =
  not(strictRetry) implies not(shouldAttachImage(AttachOnEscalation, true, strictRetry))

pure def lawImageTokensNonNegative(width: int, height: int, pixelsPerToken: int): bool =
  estimateImageTokens(width, height, pixelsPerToken) >= 0

pure def lawClampWithinPositiveBounds(value: int, limit: int): bool =
  limit > 0 implies (clampCoord(value, limit) >= 0 and clampCoord(value, limit) < limit)
```

### Bounded observation window enforces history and retained-image ceilings while tracking saved tokens

Each captured frame either records a changed observation (keeping retained images within `maxImages` and history entries within `maxEntries`) or deduplicates an unchanged frame and credits the avoided image tokens.

```quint
type ObservationWindow = {
  maxEntries: int,
  maxImages: int,
  entries: int,
  retainedImages: int,
  framesCaptured: int,
  framesDeduplicated: int,
  tokensSaved: int
}

pure val initial: ObservationWindow = {
  maxEntries: 8,
  maxImages: 2,
  entries: 0,
  retainedImages: 0,
  framesCaptured: 0,
  framesDeduplicated: 0,
  tokensSaved: 0
}

pure def canRecordChangedFrame(w: ObservationWindow, attachImage: bool, tokensAvoided: int): bool =
  tokensAvoided >= 0

pure def recordChangedFrame(w: ObservationWindow, attachImage: bool, tokensAvoided: int): ObservationWindow = {
  val nextEntries = if (w.entries < w.maxEntries) w.entries + 1 else w.maxEntries
  val rawImages = if (attachImage) w.retainedImages + 1 else w.retainedImages
  val cappedImages = if (rawImages > w.maxImages) w.maxImages else rawImages
  val nextImages = if (cappedImages > nextEntries) nextEntries else cappedImages
  {
    ...w,
    entries: nextEntries,
    retainedImages: nextImages,
    framesCaptured: w.framesCaptured + 1,
    tokensSaved: if (attachImage) w.tokensSaved else w.tokensSaved + tokensAvoided
  }
}

pure def canRecordUnchangedFrame(w: ObservationWindow, tokensAvoided: int): bool =
  w.framesCaptured > 0 and tokensAvoided >= 0

pure def recordUnchangedFrame(w: ObservationWindow, tokensAvoided: int): ObservationWindow = {
  ...w,
  framesDeduplicated: w.framesDeduplicated + 1,
  tokensSaved: w.tokensSaved + tokensAvoided
}

pure def canCompactWindow(w: ObservationWindow, keepEntries: int): bool =
  keepEntries >= 0 and keepEntries < w.entries

pure def compactWindow(w: ObservationWindow, keepEntries: int): ObservationWindow = {
  ...w,
  entries: keepEntries,
  retainedImages: if (w.retainedImages > keepEntries) keepEntries else w.retainedImages
}
```

### Observation window invariants guarantee bounded context and non-negative savings

History never exceeds `maxEntries`, retained screenshots never exceed `maxImages` or `entries`, and deduplication counters never decrease.

```quint
pure def alwaysBoundsConfigured(w: ObservationWindow): bool =
  w.maxEntries >= 1 and w.maxImages >= 0 and w.maxImages <= w.maxEntries

pure def alwaysHistoryBounded(w: ObservationWindow): bool =
  w.entries >= 0 and w.entries <= w.maxEntries

pure def alwaysImagesBounded(w: ObservationWindow): bool =
  w.retainedImages >= 0 and w.retainedImages <= w.maxImages and w.retainedImages <= w.entries

pure def alwaysMetricsNonNegative(w: ObservationWindow): bool =
  w.framesCaptured >= 0 and w.framesDeduplicated >= 0 and w.tokensSaved >= 0

pure def stepMetricsMonotonic(before: ObservationWindow, after: ObservationWindow): bool =
  after.framesCaptured >= before.framesCaptured and
  after.framesDeduplicated >= before.framesDeduplicated and
  after.tokensSaved >= before.tokensSaved

pure def sometimesDeduplicatedSavedTokens(w: ObservationWindow): bool =
  w.framesDeduplicated >= 1 and w.tokensSaved > 0

pure def sometimesCompactedWindow(w: ObservationWindow): bool =
  w.framesCaptured >= 2 and w.entries == 1

pure val tokensAvoidedValues = Set(-1, 0, 1, 5)
pure val keepEntriesValues = Set(0, 1, 2)
pure val eval_witness_sometimesDeduplicatedSavedTokens = (("recordChangedFrame", true, 0), ("recordUnchangedFrame", 5))
pure val eval_witness_sometimesCompactedWindow = (("recordChangedFrame", true, 0), ("recordChangedFrame", false, 5), ("compactWindow", 1))
```

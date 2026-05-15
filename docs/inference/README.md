# Inference / runtime docs

Cross-cutting runtime contracts. Each doc here is the source of truth
for one seam — if code conflicts with the doc, fix the code or update
the doc, but do not maintain a parallel story.

- [`vision-cua-boundary.md`](./vision-cua-boundary.md) — ownership and
  runtime wiring between `@elizaos/plugin-vision` and
  `@elizaos/plugin-computeruse`. Capture flows one way (vision →
  computeruse via `runtime.getService("computeruse")`); OCR-with-coords
  flows the other way (computeruse → vision via the
  `registerCoordOcrProvider` registry seam).
- [`voice-quality-metrics.md`](./voice-quality-metrics.md) — quality
  metric definitions used by the voice loop.

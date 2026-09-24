# @elizaos/bench-eliza-1-vision-cua-e2e

End-to-end harness that exercises the eliza-1 vision + plugin-computeruse loop: capture
all displays -> tile -> IMAGE_DESCRIPTION + OCR-with-coords -> ground a UI element ->
click -> re-capture and verify state change. Stub-mode by default; flip
ELIZA_VISION_CUA_E2E_REAL=1 to wire to the real runtime.

## Development

Install dependencies with `bun install` at the repository root. Run from that root:

```bash
bun run --cwd packages/benchmarks/suites/eliza-1/vision-cua-e2e typecheck  # static validation
```

No standalone build script is defined; this package is consumed or executed from source.

No standalone `test` script is defined in this package. Typechecking is not a substitute for runtime tests.

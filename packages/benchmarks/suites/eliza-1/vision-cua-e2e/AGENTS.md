# @elizaos/bench-eliza-1-vision-cua-e2e

End-to-end harness that exercises the eliza-1 vision + plugin-computeruse loop: capture
all displays -> tile -> IMAGE_DESCRIPTION + OCR-with-coords -> ground a UI element ->
click -> re-capture and verify state change. Stub-mode by default; flip
ELIZA_VISION_CUA_E2E_REAL=1 to wire to the real runtime.

Build, test, and setup: [README.md](README.md).

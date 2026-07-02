# @elizaos/capacitor-mlkit-text

Android ML Kit text recognition plugin for elizaOS.

Exports a Capacitor plugin named `Tesseract` with a Tesseract-compatible
`recognize({ image })` method. `image` is a base64-encoded PNG/JPEG/WebP. The
result is `{ words }`, where each word has `text`, `left`, `top`, `width`,
`height`, `confidence`, `block`, `par`, and `line` fields.

This package does not commit OCR model binaries.

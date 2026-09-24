# @elizaos/capacitor-mlkit-text

Android ML Kit text recognition plugin for elizaOS.

Exports a Capacitor plugin named `Tesseract` with a Tesseract-compatible
`recognize({ image })` method. `image` is a base64-encoded PNG/JPEG/WebP. The
result is `{ words }`, where each word has `text`, `left`, `top`, `width`,
`height`, `confidence`, `block`, `par`, and `line` fields.

This package does not commit OCR model binaries.

Android preserves the engine's actual word confidence on a 0–100 scale, including
fractional values. It does not substitute full confidence for uncertain text.
The bundled recognizer works without installing Google Play services; real-device
coverage compares bridge scores with the engine's results and checks text,
bounding boxes, line grouping, and blank images.

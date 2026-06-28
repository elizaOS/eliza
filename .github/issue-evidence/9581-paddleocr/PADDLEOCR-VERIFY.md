# #9581 — PaddleOcrService live-engine verification (Linux x86_64)

## Bug

`pip install paddleocr` now resolves to **paddleocr 3.7.0 / paddlepaddle 3.3.1 (CPU)**.
The shipped `PADDLE_PY` wrapper in `plugins/plugin-vision/src/ocr-service-paddleocr.ts`
was written for the **2.x** API:

- `PaddleOCR(use_angle_cls=True, lang="en", show_log=False)` — `show_log` was
  **removed** in 3.x → `ValueError: Unknown argument: show_log`.
- `ocr.ocr(path, cls=True)` — replaced by `predict()` in 3.x.
- 2.x return shape `[page][det] = [box, (text, conf)]` — 3.x returns result
  objects with parallel `rec_texts` / `rec_scores` / `rec_polys`.

A bare `except: print("[]")` **swallowed** the `ValueError`, so `describe()`
silently returned **zero** OCR blocks. The provider was non-functional against a
current `pip install paddleocr`, with no error surfaced.

## Fix (wrapper-only; JS parser/mapper was already correct)

`PaddleOCR(lang="en", use_textline_orientation=True, enable_mkldnn=False)` +
`ocr.predict()`, mapping `rec_polys/rec_texts/rec_scores` into the same stable
`[{box,text,conf}]` JSON the parser already consumes. The silent `except` is
replaced with a stderr diagnostic (`emit_empty`) so a future API break is
observable in logs instead of degrading to a silent empty result.
`enable_mkldnn=False` avoids the 3.x oneDNN PIR-executor crash
(`NotImplementedError … onednn_instruction.cc:116`) seen on this CPU.

## Verification

Known-text image `test-image.png` (900×360, three lines), run through the
service's **exact** `PADDLE_PY` (extracted from the .ts and run via the same
`python3 -c …` invocation `describe()` uses) against the real engine:

| | Output |
|---|---|
| **Before** (`before-old-wrapper-output.json`) | `[]` (ValueError swallowed) |
| **After** (`after-fixed-wrapper-output.json`) | 3 lines, all verbatim |

```
 • Eliza OCR 12345    conf 0.9997   box (27,30)-(456,88)
 • PaddleOCR Verify   conf 0.9998   box (17,136)-(475,204)
 • Hello World 9581   conf 1.0000   box (16,248)-(466,304)
```

`overlay.png` shows the detected boxes landing on the correct rows. The boxes
round-trip through `mapPaddleOcrJsonToResult` into display-absolute
`OcrWithCoordsBlock`s (per-line text + bbox + confidence), the same shape as the
Tesseract/Windows providers.

Engine: paddleocr 3.7.0, paddlepaddle 3.3.1 (CPU), Python 3, Linux x86_64.

# doctr-cpp — native runtime

Standalone C library that ports mindee/docTR detection and recognition
heads to a native CPU reference runtime, replacing plugin-vision's
transitional `RapidOcrCoordAdapter` with a native hierarchical OCR
provider once production parity rollout completes.

This document is the contract the runtime must satisfy. The public ABI
in `include/doctr/doctr.h` is implemented by `src/doctr_runtime.c`,
which loads a docTR GGUF and dispatches to pure-C detector and
recognizer reference forwards. Backend upgrades must stay behind the
same ABI.

## Why this lives here

- `plugins/plugin-vision/src/ocr-with-coords.ts` declares the
  `OcrWithCoordsService` interface that plugin-computeruse consumes via
  the `registerCoordOcrProvider` slot in
  `plugins/plugin-computeruse/src/mobile/ocr-provider.ts`.
- The transitional adapter wraps `RapidOCRService` (PP-OCRv5 over
  onnxruntime-node). The native docTR runtime keeps OCR on the local
  inference fabric.
- docTR's two heads fit the local runtime shape: `db_resnet50` is a
  fully convolutional DBNet detector, and `crnn_vgg16_bn` is a VGG +
  BiLSTM + CTC recognizer.

## Upstream Pin

- Repo: https://github.com/mindee/doctr
- Pin: `python-doctr==1.0.1`, recorded in
  `scripts/doctr_to_gguf.py` and the GGUF metadata key
  `doctr.upstream_pin`.
- Detection: `db_resnet50`, letterbox input size 1024.
- Recognition: `crnn_vgg16_bn`, RGB word crops at height 32.

## C ABI

The native CPU runtime implements the ABI in `include/doctr/doctr.h`:

- `doctr_open(const char *gguf_path, doctr_session **out)` loads a GGUF
  produced by `scripts/doctr_to_gguf.py`, validates
  `doctr.detector`, `doctr.recognizer`, `doctr.detector_input_size`,
  `doctr.recognizer_input_h`, and stores the CTC vocab.
- `doctr_close(doctr_session *)` releases the session and is NULL-safe.
- `doctr_detect(session, image, out, max_detections, *out_count)` runs
  db_resnet50 and DBNet postprocess. `-ENOSPC` plus filled
  `*out_count` means the caller should retry with a larger buffer.
- `doctr_recognize_word(session, crop, *out)` runs crnn_vgg16_bn and
  greedy CTC decode into caller-owned UTF-8 and confidence buffers.
- `doctr_active_backend()` returns `"cpu-ref"` for this scalar runtime;
  dispatcher-backed builds can report `"ggml-cpu"`, `"ggml-metal"`, or
  another bound backend name.

Coordinates are source-image absolute `{x, y, width, height}` pixels.
Threading is reentrant across distinct sessions; sharing one session
across threads is the caller's mutex problem.

Error codes are negative errno-style values: `-ENOENT` for missing
GGUF, `-EINVAL` for shape or argument mismatch, `-ENOSPC` for
caller-buffer overflow, and `-ENOMEM` for allocation failure. There are
no silent fallbacks.

## GGUF Conversion

`scripts/doctr_to_gguf.py` mirrors the layering in
`packages/native/plugins/polarquant-cpu/scripts/polarquant_to_gguf.py`:

- one writer, written-once metadata block, all tensors packed in a
  single deterministic pass;
- locked block-format constants (`DETECTOR_INPUT_SIZE = 1024`,
  `RECOGNIZER_INPUT_HEIGHT = 32`);
- pinned upstream package recorded in code and metadata;
- strict state-dict shape validation so an unsupported upstream rename
  cannot pass for a working artifact.

Tensors are emitted as fp32. Quantized builds can later layer Q4_POLAR
or TurboQuant on the recognizer CTC weights and detector 3x3 convs
without changing the public ABI.

## Runtime Internals

- `src/doctr_runtime.c` owns session lifecycle and ABI dispatch.
- `src/doctr_gguf.c` is the in-house GGUF v3 reader for fp32 tensors
  and string/uint32 metadata.
- `src/doctr_image.c` handles letterbox and crop resize/normalization.
- `src/doctr_kernels.c` contains scalar Conv2D, BN affine, pooling,
  transpose-conv, LSTM, linear, sigmoid, and softmax helpers.
- `src/doctr_detector_ref.c` runs the db_resnet50 + FPN + DBNet
  probability head and calls `src/doctr_polygon.c` for postprocess.
- `src/doctr_recognizer_ref.c` runs crnn_vgg16_bn and calls
  `src/doctr_ctc.c` for greedy decode.

The current runtime is intentionally scalar and reference-oriented.
ggml/SIMD dispatch can replace internal kernels behind the same
session and ABI contracts.

## Replacement Of RapidOcrCoordAdapter

Once GGUF fixtures and parity evidence are staged, plugin-vision can
replace `RapidOcrCoordAdapter` with a `DoctrCoordOcrService` that calls
this library. The `OcrWithCoordsService` interface, semantic-position
rule, and registry slot stay unchanged.

## Build

```
cmake -B build -S packages/native/plugins/doctr-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libdoctr.a` plus `doctr_abi_smoke`, which verifies public ABI
linking and error contracts.

## Remaining Rollout Work

- Add parity fixtures: run the docTR Python reference and this library
  over real document crops, then assert per-bbox IoU and per-word edit
  distance thresholds.
- Stage production GGUF artifacts and wire plugin-vision to the
  `DoctrCoordOcrService` binding.
- Add optional ggml / SIMD dispatch behind the same public ABI.

<!-- BEGIN: evidence-and-e2e-mandate (managed; canonical standard = repo-root PR_EVIDENCE.md) -->
## ⛔ NON-NEGOTIABLE — evidence, trajectories & real end-to-end tests

> The binding, repo-wide standard is **[PR_EVIDENCE.md](../../../../PR_EVIDENCE.md)**. Read it.
> Nothing in this package is *done* until it is *proven* done — a reviewer must confirm it
> works **without reading the code**, from the artifacts you attach. This applies to **every**
> feature, fix, refactor, and chore here. "Tests pass" is not proof; "CI is green" is not proof.

- **Record AND read model trajectories.** Capture the *actual* inputs and outputs of the model
  from a **live** LLM — not the deterministic proxy, not a mock: the prompt, the
  providers/context, the raw model output, every tool/action call, and the result. Then **open
  the trajectory and review it by hand.** A captured-but-unread trajectory is not evidence
  (`packages/scenario-runner/bin/eliza-scenarios run <scenario> --report <out>`).
- **Real, full-featured E2E — no larp.** Every feature ships detailed end-to-end tests that
  drive the *real* path end to end. Not the happy "front door" only: cover error paths,
  edge/empty/invalid input, concurrency, roles/permissions, and adversarial input. A test that
  asserts against a mock/stub/fixture standing in for the thing under test **does not count**.
  If the real model/device/chain/connector/account is hard to reach, **make it reachable — that
  is the work**, not an excuse to mock. If the existing tests here are shallow or mocked, fixing
  them is part of your change.
- **Screenshots + logs at every phase**, plus a **complete walkthrough video/run-through** of
  the entire feature or view, start to finish (`bun run test:e2e:record`).
- **Manually review every artifact the change touches** — never just the green check: client
  logs (console + network), server logs (`[ClassName] …`), the model trajectories in and out,
  before/after full-page screenshots, **and the domain artifacts listed below for this package.**
- **No residuals. No shortcuts.** The goal is not "done" — it is *everything* done. Clear every
  blocker by the **hard path**: build the real architecture, stand up the real
  model/device/service, actually test it. Never leave a TODO, a stub, a stepping-stone, or a
  "follow-up." When unsure, research thoroughly, weigh the options, and ship the best,
  highest-effort, production-ready version. Keep going until every possibility is exhausted.

Artifacts → attached inline in the PR (MP4 video, JPG screenshots, logs in `<details>`); attach each evidence type **or**
explicitly mark it N/A with a reason — never leave it blank. If `develop` moved and changed
behavior, **re-capture** evidence; stale proof is worse than none.

**Capture & manually review for this package — native / on-device bridge:**
- The capability run on a **real device or simulator** — not desktop Chromium against a mocked bridge (see #9967/#9580): device logs + the captured output (photo, OCR text, detection boxes, transcript, sensor reading).
- Parity vs the reference implementation where one exists (e.g. the Python/Ultralytics reference), with the numeric tolerances actually met.
- Permission-denied, no-hardware, and background/foreground lifecycle paths.
- A short recording of the on-device run; confirm the build under test is yours (versionName / a known on-screen change), not a stale install.
<!-- END: evidence-and-e2e-mandate -->

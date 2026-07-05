# wakeword-cpp — Phase 2 (real runtime)

Standalone C library that ports
[dscripka/openWakeWord](https://github.com/dscripka/openWakeWord)'s
three-stage streaming wake-word pipeline (melspectrogram → embedding
CNN → dense classifier head) off `onnxruntime-node` and into a pure-C
runtime exposed through a frozen C ABI. The TypeScript counterpart in
`plugins/plugin-local-inference/src/services/voice/wake-word-ggml.ts`
binds the shared library via `bun:ffi`; the voice lifecycle in
`plugins/plugin-local-inference/src/services/voice/wake-word.ts`
prefers the standalone path and falls back to the older fused
`libelizainference` wake-word runtime when the standalone build / GGUFs
are not present.

## Why this lives here

- `plugins/plugin-local-inference/src/services/voice/wake-word.ts`
  used to load three ONNX graphs through `onnxruntime-node`. The
  CLAUDE.md mandate is to remove all ONNX usage from the runtime;
  this library is the standalone replacement and is now wired in as
  the preferred provider.
- The three-stage shape (melspec / embedding / classifier) maps
  cleanly onto a small set of pure-C kernels: STFT (real + imag conv
  bases) + per-call relmax dB-log floor for the melspec, Conv2D +
  bias + LeakyReLU(0.2) + Max(·, -0.4) + MaxPool for the embedding,
  Gemm + LayerNorm + ReLU + Sigmoid for the classifier. None of these
  need ggml or llama.cpp — the library does not link either.
- Sibling native-plugins (`silero-vad-cpp`, `doctr-cpp`,
  `voice-classifier-cpp`) follow the same pattern: a frozen C ABI, an
  in-house GGUF v3 reader, fp16 weights upcast to fp32 at session
  open, and a scalar-fp32 reference forward pass. We mirror their
  layout (`src/wakeword_runtime.c` ≈ `src/silero_vad_runtime.c`).

## Upstream pin

- Repo: <https://github.com/dscripka/openWakeWord> (Apache-2.0)
- Pinned commit: **`368c03716d1e92591906a84949bc477f3a834455`** (latest
  upstream stable as of bring-up). Recorded both here and in
  `scripts/wakeword_to_gguf.py::OPENWAKEWORD_UPSTREAM_COMMIT`. The
  runtime reads `wakeword.upstream_commit` from each GGUF and refuses
  loads when the three GGUFs disagree among themselves.
- The **real** "hey eliza" head now ships, registered as `wakeword` v0.3.0
  (`packages/shared/src/local-inference/voice-models.ts`,
  `voice/wakeword/hey-eliza.{melspec,embedding,classifier}.gguf` on
  HF `elizaos/eliza-1@c544bb4c`). It was trained by
  `packages/training/scripts/wakeword/train_eliza1_wakeword_head.py`
  (`--no-mel-rescale`) and is verified end-to-end on real audio:
  "hey eliza" scores ~1.0 while "hey jarvis" scores ~0.13 (i.e. it is the
  trained eliza-1 head, NOT the old `hey_jarvis_v0.1` placeholder).
  Reproduce with `test/wakeword_score_raw.c` — see
  #9880. The `hey-eliza-int8.onnx`
  placeholder note is historical (pre-v0.3.0).

## Three-stage pipeline + GGUF conversion

The runtime loads three GGUFs per session, mirroring the three ONNX
graphs:

| Stage        | ONNX source                  | GGUF metadata `arch`    | What's inside                                                                                       |
|--------------|------------------------------|-------------------------|-----------------------------------------------------------------------------------------------------|
| melspec      | `melspectrogram.onnx`        | `wakeword-melspec`      | fp16 STFT real basis (257, 1, 512) + STFT imag basis (257, 1, 512) + mel filter matrix (257, 32). |
| embedding    | `embedding_model.onnx`       | `wakeword-embedding`    | fp16 weights for 20 Conv2D layers + biases for layers 0..18 (layer 19 has no bias).                |
| classifier   | `<wake-phrase>.onnx`         | `wakeword-classifier`   | fp16 weights for the 4-layer MLP head (Gemm 1536→96, LayerNorm, Gemm 96→96, Gemm 96→1).            |

`scripts/wakeword_to_gguf.py` is the single converter. Given the three
upstream ONNX files and a phrase string, it writes
`<phrase-slug>.{melspec,embedding,classifier}.gguf` to `--out-dir`.
Total size for the bundled "hey eliza" head: ≈1.5 MB across the three
files (3 + 39 + 8 fp16 tensors).

Locked block-format constants live at the top of that script (and are
re-asserted in `src/wakeword_internal.h` and validated in
`src/wakeword_runtime.c::validate_common_metadata`):

```
MELSPEC_N_MELS    = 32
MELSPEC_N_FFT     = 512   # NOT 400; the upstream ONNX uses a 32 ms STFT window
MELSPEC_HOP       = 160   # 10 ms @ 16 kHz
MELSPEC_WIN       = 512
EMBEDDING_DIM     = 96
EMBEDDING_WINDOW  = 76    # mel frames per embedding step
HEAD_WINDOW       = 16    # embeddings per classifier step
```

## C ABI (frozen by `include/wakeword/wakeword.h`)

The runtime implements every entry point declared in the header. The
contract is unchanged from Phase 1 — only the implementation behind
it became real.

- `wakeword_open(melspec_gguf, embedding_gguf, classifier_gguf, *out)`
  — load all three GGUFs, validate that
  `wakeword.upstream_commit` matches across them and that
  `wakeword.{melspec_n_mels, melspec_hop, embedding_dim,
  embedding_window, head_window}` agree with this header's pinned
  variants, allocate the streaming session.
- `wakeword_process(h, pcm_16khz, n_samples, *score_out)` — push
  arbitrary 16 kHz mono float PCM, get back the most recent
  classifier probability ∈ [0, 1]. Internally the runtime carries a
  PCM buffer (up to 511 samples), runs the streaming melspec on every
  call, fills a 76-frame mel ring; every 8 mel frames (= 80 ms) it
  evaluates the embedding model on the current 76-frame window and
  pushes the resulting 96-d embedding into a 16-deep ring; once the
  embedding ring is full it runs the classifier head and updates the
  most recent score. Early calls (before enough mel + embedding
  context has accumulated, ≈1.9 s of audio) return 0.
- `wakeword_set_threshold(h, threshold)` — advisory state stored on
  the session for higher-level callers that want a boolean
  fired/not-fired view. Default `WAKEWORD_DEFAULT_THRESHOLD = 0.5`.
- `wakeword_close(h)` — releases all owned tensors, the streaming
  state, and the session struct. NULL-safe.
- `wakeword_active_backend()` — diagnostics. Returns `"native-cpu"`
  on this build (pure-fp32 scalar reference; no SIMD, no ggml link).

Coordinate convention: PCM is 16 kHz mono float in [-1, 1]. Anything
else is `-EINVAL`.

Threading: reentrant against distinct `wakeword_handle` values.
Sharing one handle across threads is the caller's mutex problem.

Error codes: `errno`-style negatives. `-ENOENT` for missing GGUF,
`-EINVAL` for shape / argument / metadata-mismatch problems, `-EIO`
for a corrupt GGUF, `-ENOMEM` on allocation failure. No silent
fallbacks.

## Build

```
cmake -B build -S packages/native/plugins/wakeword-cpp
cmake --build build -j
ctest --test-dir build --output-on-failure
```

Output: `libwakeword.a` (linked by the in-tree ctest binaries) and
`libwakeword.so`/`.dylib`/`.dll` (dlopen'd by the bun:ffi binding).

Test binaries:

- `wakeword_stub_smoke` — link-only check on the public ABI (NULL
  arguments, missing files, NULL handle entry points).
- `wakeword_melspec_test` — spectral correctness check for the
  legacy (no-GGUF) C-side mel front-end on a 1 kHz / 4 kHz tone.
  This is unchanged from Phase 1; the runtime path uses the
  upstream filter bank loaded from `melspec.gguf` instead.
- `wakeword_window_test` — sliding-window framing correctness;
  unchanged from Phase 1.
- `wakeword_runtime_test` — end-to-end smoke against the real
  runtime. Loads the three GGUFs and runs silence + a synthesized
  chirp through `wakeword_process`. **Refuses** to run without the
  three GGUFs in
  `${CMAKE_BINARY_DIR}/wakeword/<phrase>.{melspec,embedding,classifier}.gguf`
  — a missing fixture must NOT pass for "OK". Stage them via
  `python3 scripts/wakeword_to_gguf.py --out-dir build/wakeword …`.
- `wakeword_parity_test` (Python) — drives the C runtime AND the
  upstream openWakeWord ONNX bundle via onnxruntime, asserts
  per-chunk probability agreement within ±0.15 absolute on three
  synthetic clips. Skips with exit 77 when `python3` /
  `onnxruntime` / `numpy` / `onnx` / the GGUFs / the ONNX bundle
  are not present.

All five pass on the dev host.

## Replacement of `wake-word.ts`

The bun:ffi binding at `wake-word-ggml.ts` is now the preferred
`WakeWordModel` implementation. `wake-word.ts::loadBundledWakeWordModel`
tries `OpenWakeWordGgmlModel` first (when the standalone library +
three GGUFs are on disk) and falls back to the older fused
`libelizainference` `GgmlWakeWordModel` path. Both
`OPENWAKEWORD_PLACEHOLDER_HEADS` and `resolveWakeWordModel` stay
exactly as they were — those interfaces are still the bundle-side
contract for the fused path.

The fused path is *not* deleted: it remains the fallback for Node
runtimes (where `bun:ffi` is unavailable) and for installs that ship
the older single-`openwakeword.gguf` artefact.

## Honest limitations / followups

- **Per-call relmax dB floor.** The openWakeWord melspec applies a
  per-call peak-relative -80 dB floor. The C runtime does the same
  per `wakeword_process` call (per chunk of audio); large chunk-size
  variation slightly perturbs the floor relative to the upstream
  Python reference, which usually batches whole utterances. The
  parity test's ±0.15 tolerance covers this; a future pass can add
  a streaming peak tracker if tighter agreement is needed.
- **No `wakeword_reset`.** The streaming state lives on the session
  and `wakeword_close` + `wakeword_open` is the only way to clear
  it. Adding an in-place reset is a 30-line follow-up if the voice
  lifecycle ever needs it.
- **No SIMD.** The 20-conv stack is the dominant cost (≈300 K MACs
  per 80 ms hop, ≈4 ms wall-clock on a Ryzen laptop core in `-O3`).
  Real-time stays well under 1 % of CPU but a NEON / AVX2 conv2d
  would cut it further. The dispatcher seam is in
  `wakeword_active_backend` already.
- **fp16 weight storage.** GGUF stores all weights as fp16; the
  runtime upcasts to fp32 at load time. This costs ≈1e-3 absolute
  error per multiply-accumulate vs the upstream fp32 ONNX. The
  parity test's tolerance covers this; switching to fp32 storage is
  a flip in the converter (`np.float16` → `np.float32`).

## Repo layout (post-Phase 2)

```
packages/native/plugins/wakeword-cpp/
├── AGENTS.md                       # this file
├── CMakeLists.txt
├── README.md                       # 1-paragraph summary
├── include/wakeword/wakeword.h     # frozen C ABI
├── scripts/wakeword_to_gguf.py     # the converter
├── src/
│   ├── wakeword_internal.h         # shared dimensions & melspec API
│   ├── wakeword_melspec.c          # streaming log-mel (GGUF + legacy modes)
│   ├── wakeword_runtime.c          # session lifecycle + embedding + classifier
│   └── wakeword_window.c           # 80 ms sliding-window framer (Phase 1, unchanged)
└── test/
    ├── wakeword_melspec_test.c     # spectral correctness (legacy mode)
    ├── wakeword_parity_test.py     # C ↔ ONNX parity gate
    ├── wakeword_runtime_test.c     # end-to-end runtime smoke
    ├── wakeword_stub_smoke.c       # public-ABI link smoke
    └── wakeword_window_test.c      # framing correctness (Phase 1, unchanged)
```

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

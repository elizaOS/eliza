# Verification recordings — #9874, #9580, #9581 (Linux x86_64 + RTX 5080)

Screen recordings demonstrating the non-UI fixes succeeding, driven through a
browser **user interface**: a small dashboard where each "Run" button executes
the **real** verification command server-side and renders the **real** output
(no hardcoded results). Recorded with Playwright (bundled chromium) on this
Linux + NVIDIA RTX 5080 Laptop (Blackwell sm_120, CUDA 12.8) host.

| File | Shows |
|---|---|
| `walkthrough-9874-9580-9581-vlm.mp4` | the full ~43 s run: all four buttons clicked live, each going green/PASS |
| `9874-planner-tests.mp4` | **#9874** — `bunx vitest run` over the 4 planner test files → **Test Files 4 passed, Tests 88 passed** |
| `9580-cuda-inference.mp4` | **#9580** — `llama-completion --list-devices` (CUDA0: RTX 5080) → full-GPU-offload generation *"The capital of France is Paris."* → `llama-bench` **backend CUDA, ngl 99, pp128 3744 t/s / tg32 64 t/s** |
| `9581-paddleocr.mp4` | **#9581** OCR — old 2.x wrapper on paddleocr 3.x → `[]` (broken), fixed wrapper → **`Eliza OCR 12345` / `PaddleOCR Verify` / `Hello World 9581`** recognized live |
| `9581-cuda-vlm.mp4` | **#9581** VLM — `llama-mtmd-cli` (Gemma-4 IMAGE_DESCRIPTION) on the GPU (`-ngl 99 --jinja`) reads the test image and transcribes `Eliza OCR 12345…`; CUDA0 RTX 5080 backend |
| `final-state-all-pass.png` | final dashboard frame, all four PASS |
| `cuda-vlm-raw/` | raw `llama-mtmd-cli` run: `EVIDENCE.md`, clean description, `nvidia-smi` during the run (90-92% GPU util, 8.7 GB VRAM) |
| `9580-cuda-bench.txt`, `9580-cuda-generation.txt` | raw CUDA outputs |

Each command is the real one (the same invocation the fix/test uses); the
dashboard is only the trigger + display surface. For the UI-facing fix (#9880
wake word) the recording is the Pixel 9a capture under
[`../9880-wake-word/`](../9880-wake-word/).

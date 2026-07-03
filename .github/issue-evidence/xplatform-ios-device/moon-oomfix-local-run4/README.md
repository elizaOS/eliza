# On-device local-LLM — MoonCycles (iPhone 16 Pro Max, A18, iOS 18.7.8)

Fully-autonomous XCUITest drive of the #11612-fixed build (recoverable Metal failure + bf16 kernel + GPU-OOM admission). The Capacitor WKWebView onboarding rows are invisible to XCUITest, so `tapWebChoice` was hardened with **raw normalized-coordinate taps** for the placement + provider rows (the chat UI itself *does* expose accessibility, so composer typing / send / reply-detection work directly).

## PROVEN on the real device (this run)
1. **Autonomous onboarding** — coordinate-tapped "On this device" (placement, checked ✓ in `local-020-after-provider.png`) → "On this device (recommended)" (provider).
2. **XCUITest typed a real prompt** into the WKWebView composer — "Say hello in exactly three words." (`local-075-reply-arrived.png`).
3. **The GPU-OOM fix works on-device** — `ggml.log`:
   - `llama_model_loader: … 601 tensors from …/eliza-1-2b-128k.gguf`, `general.architecture = gemma4`, `size_label = 4.6B`, `embedding_length = 1536` — the real gemma4 eliza-1-2b loaded.
   - **`load_tensors: offloaded 0/36 layers to GPU`** — the memory-admission fix reduced GPU offload to fit the A18 working-set budget → the model loaded on CPU with **no `kIOGPUCommandBufferCallbackErrorOutOfMemory`, no `ret = -3`, no jetsam**. This is exactly the #11612 fix behaving correctly on constrained hardware (pre-fix it OOM'd at `n_gpu_layers:999`).

## The one remaining bit
The prompt was sent while the CPU model (0/36 GPU layers → CPU inference of a 4.6B model) was still warming, so it returned the app's own "message didn't reach the agent — still starting up. Retry" fallback rather than a generated reply. Fixed by a **re-send-until-ready loop** in `verifyChat` (committed). Capturing the final *generated reply text* needs one more run with the iOS "Enable UI Automation" authorization active (it re-prompts for the passcode after device idle/re-lock — an iOS security gate, not a code issue). To make it persistent for future device UI tests: Settings → Developer → Enable UI Automation.

# eliza-1 local model install guide

How to get eliza-1 running locally on each supported platform. The default
path requires no manual env vars or `ensure-*` scripts — just open the app,
pick a tier, and let the runtime download from HuggingFace.

---

## Quick start (all platforms)

1. **Open the Eliza app** (or run `bun run dev` in the repo).
2. **Complete onboarding** — the tier picker appears during first run.
3. **Pick a tier** based on your RAM (see table below).
4. **Wait** — the runtime downloads the bundle from `elizaos/eliza-1` on
   HuggingFace, verifies SHA-256 checksums, and boots automatically.
5. **Voice is on** — ASR, TTS (OmniVoice + Kokoro), and VAD all start
   automatically as part of the bundle.

No `HF_TOKEN` required for the public `elizaos/eliza-1` repo.

---

## Tier selection guide

| Tier | RAM | VRAM | Best for |
|------|-----|------|----------|
| `eliza-1-0_8b` | 2 GB+ | Any | Low-memory phones, CPU fallback |
| `eliza-1-2b` *(default)* | 4 GB+ | Any | Standard phones, fast laptops |
| `eliza-1-4b` | 10 GB+ | Any | Modern laptops/desktops |
| `eliza-1-9b` | 12 GB+ | RTX 3090+ recommended | Workstations |
| `eliza-1-27b` | 32 GB+ | RTX 4090+ recommended | High-end workstations |
| `eliza-1-27b-256k` | 96 GB+ | Multi-GPU | Server / professional (262k natural context) |

The runtime auto-selects a tier based on your hardware if you skip the picker.
You can always change tiers in **Settings → Local Model**.

**Note:** The `eliza-1-27b-1m` tier was retired in the Gauntlet sub-wave (2026-05-15).
The maximum supported context is `27b-256k` (262k tokens natural context). No 1M tier is
available or planned.

### Voice sub-model repos (advanced / separate download)

Each voice component is also published as a standalone HuggingFace repo:

| Component | Repo | Notes |
|-----------|------|-------|
| ASR | `elizaos/eliza-1-voice-asr` | Qwen3-ASR GGUF streaming |
| Turn detector | `elizaos/eliza-1-voice-turn` | LiveKit EN + INTL |
| Emotion | `elizaos/eliza-1-voice-emotion` | Wav2Small V-A-D |
| Speaker encoder | `elizaos/eliza-1-voice-speaker` | WeSpeaker ResNet34-LM |
| Diarizer | `elizaos/eliza-1-voice-diarizer` | Pyannote-segmentation-3.0 |
| VAD | `elizaos/eliza-1-voice-vad` | Silero VAD v5.1.2 |
| Wakeword | `elizaos/eliza-1-voice-wakeword` | hey-eliza head |
| Kokoro TTS | `elizaos/eliza-1-voice-kokoro` | Kokoro-82M base |
| OmniVoice TTS | `elizaos/eliza-1-voice-omnivoice` | OmniVoice presets |
| Embedding | `elizaos/eliza-1-voice-embedding` | Qwen3-Embedding GGUF |

These are bundled into the main tier download automatically — the separate repos exist
for advanced use cases (custom pipelines, model comparison, research).

---

## Linux (x86-64)

**Status:** Full support. CUDA, Vulkan, and CPU backends are all tested.

### Recommended setup

```bash
# NVIDIA GPU users — install CUDA 12.x first
sudo apt install nvidia-cuda-toolkit

# Start the dev server (models download on first local inference request)
bun run dev

# Or run the production CLI
bunx eliza
```

The runtime detects CUDA automatically and uses GPU acceleration.

### Verified backends on Linux x86-64

| Backend | Status |
|---------|--------|
| CUDA (NVIDIA) | ✓ Fully supported |
| Vulkan | ✓ Fully supported |
| ROCm (AMD) | ✓ Supported on 9b+ tiers |
| CPU (SIMD) | ✓ Fallback for all tiers |

### Bundle download location

Models land in `~/.milady/local-inference/models/` (or `$ELIZA_STATE_DIR/local-inference/models/`).
Download is resumable — if interrupted, restart and it picks up where it left off.

### Per-tier download sizes (approximate, Q4_K_M)

| Tier | Text GGUF | + Voice | + ASR | Total |
|------|-----------|---------|-------|-------|
| 0_8b | 531 MB | ~820 MB | ~200 MB | ~1.6 GB |
| 2b | 1.2 GB | ~820 MB | ~200 MB | ~2.2 GB |
| 4b | 2.7 GB | ~820 MB | ~200 MB | ~3.7 GB |
| 9b | 5.4 GB | ~860 MB | ~200 MB | ~6.5 GB |
| 27b | 15.8 GB | ~420 MB | ~200 MB | ~16.4 GB |
| 27b-256k | 15.8 GB | ~420 MB | ~200 MB | ~16.4 GB |

---

## macOS (Apple Silicon — M1/M2/M3/M4)

**Status:** Full support via Metal backend. Unified memory architecture
means RAM and VRAM budgets are shared — 16 GB Mac can run the 4b tier.

### Requirements

- macOS 12.0+ (Monterey or later)
- At least 8 GB unified memory recommended for 2b tier
- Eliza app (`.dmg` from releases) or `bun run dev`

### Backend

Metal backend is auto-selected on Apple Silicon. The runtime uses the
`--gpu metal` flag with llama-server. No CUDA setup required.

### Code path

`packages/agent/src/runtime/eliza.ts` → backend-selector → `llama-server`
with Metal. The `verify.ts` smoke-run validates Metal on first boot.

---

## macOS (Intel)

**Status:** Supported via CPU backend. No Metal on Intel iGPU/dGPU.

- Expect 3-5x slower than Apple Silicon for the same tier.
- Recommend `eliza-1-0_8b` or `eliza-1-2b` only.

---

## Windows (x86-64)

**Status:** Supported via CUDA (NVIDIA) and Vulkan backends. CPU fallback
available.

### Requirements

- Windows 10/11 64-bit
- NVIDIA GPU: CUDA 12.x + cuDNN (optional, improves throughput)
- AMD GPU: Vulkan driver 1.3+
- Eliza app installer (`.exe` from releases)

### Notes

- The app installer bundles the llama-server binary with CUDA support.
- First launch may trigger Windows Defender — allow the binary.
- Model downloads go to `%APPDATA%\milady\local-inference\models\`.

---

## Windows (ARM64)

**Status:** Supported via CPU backend (SIMD optimized). CUDA not available
on ARM64 Windows. Vulkan partially supported (depends on driver).

- Verified on Snapdragon X Elite platforms (`windows-arm64-cpu` evidence
  files present in the 0_8b bundle).

---

## iOS (iPhone / iPad)

**Status:** Code paths present; hardware-constrained. Local inference is
**opt-in** (cloud default).

### How to enable

1. **Settings → Local Model → Enable local inference**
2. Pick `eliza-1-0_8b` (only tier that fits in iPhone RAM budget)
3. Download requires Wi-Fi (app enforces this to prevent mobile data charges)

### Technical details

- Metal backend via Core ML bridge (see `packages/bun-ios-runtime/`).
- Background audio entitlement required for continuous voice — enabled in
  `Info.plist` via `packages/app-core/scripts/ios/patch-plist.sh`.
- Models download to the app's Documents directory.
- iOS kills background processes; voice session resumes on app foreground.

### Code path

`plugins/plugin-local-inference/src/runtime/ios-llama-streaming.ts` →
`CapacitorLlamaPlugin` → native Metal inference.

### Limitations

- Maximum practical tier: `eliza-1-0_8b` (< 2 GB, fits iPhone 15 and later).
- No CUDA, no Vulkan.
- Wake-word detection requires background audio entitlement.

---

## Android

**Status:** Code paths present; hardware-constrained. Local inference is
**opt-in** (cloud default).

### How to enable

1. **Settings → Local Model → Enable local inference**
2. Pick `eliza-1-0_8b` (fits most mid-range Android devices)
3. Download is automatic on Wi-Fi, asks for confirmation on cellular

### Technical details

- Vulkan backend via `CapacitorPlugin.loadModel()` in
  `packages/app-core/scripts/aosp/`.
- `ElizaVoiceCaptureService` (Android foreground service) keeps voice
  recording alive when the app is backgrounded.
- Models download to internal storage (`/data/data/<pkg>/files/.eliza/`).

### Code path

`plugins/plugin-local-inference/src/services/downloader.ts` →
`elizaModelsDir()` → Android internal storage via `ELIZA_STATE_DIR`.

### Network policy

- **Wi-Fi only (default):** auto-download, auto-update.
- **Cellular:** prompt before download (see `network-policy.ts`).
- Override via **Settings → Local Model → Network policy**.

### Limitations

- Vulkan required; CPU fallback exists but is very slow on ARM32.
- Background inference limited by OS memory pressure on low-RAM devices.

---

## Environment variables (advanced)

These are optional overrides for power users and CI:

| Variable | Default | Description |
|----------|---------|-------------|
| `ELIZA_STATE_DIR` | `~/.milady` | Root for models + config |
| `ELIZA_PUBLISH_STATUS_OVERRIDES` | unset | JSON override for tier publish status |
| `ELIZA_LOCAL_ALLOW_STOCK_KV` | unset | Disable KV quant (slow, for debugging) |
| `ELIZA_LOCAL_BACKEND` | `auto` | Force `llama-server` or `node-llama-cpp` |

---

## Troubleshooting

### "Bundle incompatible with this device"

The manifest's `ramBudgetMb.min` exceeds your device's detected RAM, or
no verified backend matches your hardware. Pick a smaller tier or add more RAM.

### Download stalls

The downloader resumes automatically on restart. If it stalls permanently:
```bash
rm -rf ~/.milady/local-inference/downloads/
```

### "elizalabs/eliza-1" errors in logs (pre-fix)

If you see `elizalabs/eliza-1` in error messages, you are on a version before
commit `cd79fe1186`. Update to the latest `develop` branch.

### Voice not working

Check that:
1. The bundle includes ASR and VAD files (all published tiers do).
2. Microphone permission is granted.
3. `silero-vad-int8.onnx` exists in the bundle (check `~/.milady/local-inference/models/<tier>/vad/`).

---

## For developers: testing the download flow

```bash
# Smoke-test manifest reachability for a tier
python3 -c "
import requests, json
for tier in ['0_8b', '2b', '4b', '9b', '27b', '27b-256k']:
    r = requests.get(f'https://huggingface.co/elizaos/eliza-1/resolve/main/bundles/{tier}/eliza-1.manifest.json')
    print(f'{tier}: {r.status_code} v={r.json()[\"version\"] if r.ok else \"N/A\"}')
"

# Check installed models
ls ~/.milady/local-inference/models/

# Run the verify-on-device smoke for a tier (requires model installed)
bun run dev  # Start the runtime
# Then from another terminal:
curl -s http://localhost:31337/api/local-inference/status | jq .
```

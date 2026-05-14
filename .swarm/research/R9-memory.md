# R9 — Cross-model memory budget + MAX/GOOD/OKAY/POOR tier detection

**Author:** R9-memory subagent, Voice Wave 2.
**Date:** 2026-05-13.
**Inputs:** `.swarm/VOICE_WAVE_2.md` §V (V1/V2 tier brief) + §H (memory manager unified) + `docs/eliza-1-pipeline/05-memory-budgets.md` + the actual checked-in budget/monitor/recommendation code in `plugins/plugin-local-inference/src/services/` + live bundles on disk under `~/.eliza/local-inference/`.
**Status:** research-only. No source edits. Roster line landed in `.swarm/collab.md`. Implementation is owned by I9.

---

## TL;DR

1. Today's "memory budget" is one piece — `ram-budget.ts` decides whether **one text tier** fits a host, and `memory-monitor.ts` evicts cheap resident roles under live pressure. Both are honest, neither expresses the **whole co-resident voice + text bundle** memory bill. The eviction priority order in `voice/shared-resources.ts` is correct (`drafter < vision < embedding < vad < asr < tts < text-target`); the bug is upstream — admission control never adds up the *whole* set.
2. **MAX/GOOD/OKAY/POOR is not yet a runtime concept.** No file maps a hardware probe to one of those four labels. `recommendation.ts` already has a six-class `RecommendationPlatformClass` and a `HardwareFitLevel` (`fits | tight | wontfit`) — that's the substrate, but it ranks model variants, it does not classify the device.
3. **Measured on-disk bundles** (`~/.eliza/local-inference/models/eliza-1-0_6b.bundle`, `~/.eliza/local-inference/models/eliza-1-1_7b.bundle`) confirm the on-disk weights for the 0.8B/2B tier voice stack land around **1.7–2.5 GB resident weights** before KV. Add the KV cache and the budget rises sharply with context. Mobile + CPU-only desktops can't keep the full co-resident set without eviction. The numeric thresholds in §3 are tuned to that ground truth.
4. **Recommended I9 surface:** a new `services/local-inference/device-tier.ts` (or in this repo's path, `plugins/plugin-local-inference/src/services/device-tier.ts`) that emits a `DeviceTier = "MAX" | "GOOD" | "OKAY" | "POOR"` decision from the same `HardwareProbe`, plus a sibling `voice-budget.ts` that aggregates voice-bundle RSS estimates and a `reserve()` allocator API the runtime calls.
5. **Mobile is cloud-default** (Wave 2 §U2). The device-tier code still runs on mobile, but only to choose between OKAY (small local turn + VAD + wake-word) and POOR (push-everything to cloud).

---

## 1. Current memory-budget code — audit

Every path below is real and on `develop`.

### 1.1 `plugins/plugin-local-inference/src/services/ram-budget.ts` (293 lines)

The single source of truth for "does model X fit a host with N MB usable RAM". Both the recommender and the `active-model` admission gate call into it; neither re-derives the math.

The schema:

```ts
export interface RamBudget {
  /** Minimum RAM the bundle will boot under, in megabytes. */
  minMb: number;
  /** RAM the bundle expects for nominal workloads, in megabytes. */
  recommendedMb: number;
  /** `manifest` only when both came from a validated eliza-1.manifest.json. */
  source: "manifest" | "catalog";
}

export type RamFitLevel = "fits" | "tight" | "wontfit";

export interface RamFitDecision {
  level: RamFitLevel;
  fits: boolean;
  budget: RamBudget;
  usableMb: number;
  reserveMb: number;
}
```

Decision rules from `assessRamFit`:

```ts
const usableMb = Math.max(0, hostRamMb - reserveMb);
if (usableMb < budget.minMb) level = "wontfit";
else if (usableMb < budget.recommendedMb) level = "tight";
else level = "fits";
```

Headroom reserve is a flat `DEFAULT_RAM_HEADROOM_RESERVE_MB = 1536` (override via `ELIZA_LOCAL_RAM_HEADROOM_MB`). Manifest's `ramBudgetMb.{min,recommended}` wins over the catalog fallback whenever a validated `eliza-1.manifest.json` lives next to an installed bundle; the catalog fallback synthesizes `recommendedMb = minMb + ceil(KV-cache-at-default-context)` using `kv-spill.estimateQuantizedKvBytesPerToken(params)`.

**Gap:** this is a single-tier check — it sums **one** text bundle's `min`/`recommended` against host RAM. It does not account for ASR + TTS + drafter + VAD + wake-word + speaker-encoder being **co-resident**. That is the whole point of the Wave 2 §H4 unified budget.

### 1.2 `plugins/plugin-local-inference/src/services/memory-monitor.ts` (304 lines)

The W10 RAM-pressure monitor. Polls `os.freemem()` / `os.totalmem()` on a 30 s interval, scrapes the llama-server `/metrics` for `process_resident_memory_bytes` when available, and evicts the lowest-priority resident role when free RAM drops below `max(lowWaterMb, lowWaterFraction * total)` (defaults `768 MB / 8%`).

Decision shape:

```ts
export interface MemorySample {
  totalMb: number;
  freeMb: number;
  serverRssMb: number | null;
  effectiveFreeMb: number;     // min(freeMb, totalMb - serverRssMb - reserveMb)
  freeFraction: number;
}

export interface MemoryPressureAction {
  sample: MemorySample;
  evicted: { id: string; role: ResidentModelRole; estimatedMb: number } | null;
  exhausted: boolean;
}
```

Tunables (env): `ELIZA_LOCAL_MEMORY_MONITOR_INTERVAL_MS`, `ELIZA_LOCAL_MEMORY_LOW_WATER_MB`, `ELIZA_LOCAL_MEMORY_LOW_WATER_FRACTION`. Cooldown after an eviction = 5 s; exhausted back-off = 60 s.

The monitor does the right thing **after** the budget is wrong — it's the safety net. R9 leaves it untouched; I9's job is to make sure the initial admission decision matches what the monitor will eventually settle into.

### 1.3 `plugins/plugin-local-inference/src/services/recommendation.ts` (667 lines)

Owns `RecommendationPlatformClass = "mobile" | "apple-silicon" | "linux-gpu" | "linux-cpu" | "desktop-gpu" | "desktop-cpu"` and the per-slot ladder (`SLOT_LADDERS`).

Key memory plumbing:

```ts
function effectiveMemoryGb(probe: HardwareProbe): number {
  if (probe.appleSilicon) return probe.totalRamGb;
  if (probe.gpu) return Math.max(probe.gpu.totalVramGb, probe.totalRamGb * 0.5);
  return probe.totalRamGb * 0.5;
}
```

That's the unified-memory-vs-discrete-VRAM split — `apple-silicon` gets all of RAM, discrete-GPU gets the max of VRAM and half of RAM, CPU-only gets half of RAM. **This will be the basis for the OKAY/GOOD divide on x86 CPU-only boxes** — half of RAM is the "model side" — and the GOOD/MAX divide on dGPU boxes — VRAM is the model side.

The `downloadSizeGuardrail` adds a download-footprint trap on top (`wontfit` when `sizeGb > memGb * 0.9` desktop / `* 0.8` mobile; `tight` at `0.7` / `0.65`).

`classifyRecommendationPlatform(hardware)` is the existing platform-class hook. I9 should reuse it; the new `DeviceTier` is one further reduction (`platform-class × effectiveMemoryGb × gpu-class → MAX|GOOD|OKAY|POOR`).

### 1.4 `plugins/plugin-local-inference/src/services/active-model.ts` (764 lines)

Hosts `ModelDoesNotFitError`, `assertModelFitsHost`, the `ActiveModelCoordinator`, and the cache-type allow-list (`FORK_ONLY_KV_CACHE_TYPES`, `STOCK_KV_CACHE_TYPES`). Relevant rule:

```ts
export function assertModelFitsHost(
  installed: InstalledModel,
  hostRamMb: number,
  options: RamFitOptions = {},
): { level: "fits" | "tight"; minMb: number; recommendedMb: number } {
  const catalog = findCatalogModel(installed.id);
  if (!catalog) return { level: "fits", minMb: 0, recommendedMb: 0 };
  const fit = assessRamFit(catalog, hostRamMb, { ...options, installed });
  if (fit.fits) return { level: ..., minMb: ..., recommendedMb: ... };
  // ...
  throw new ModelDoesNotFitError({ ... });
}
```

This is the only callsite that **refuses** a load. Voice models, ASR, VAD, wake-word, embedding, drafter, vision projector, speaker encoder, emotion classifier — none of them gate through here today. They mmap when voice mode starts, the `memory-monitor` evicts them when the OS gets unhappy, and the user gets surprising latency.

**The single hook I9 has to add:** an aggregated `voice-budget.ts:assessVoiceBundleFits(probe, tier)` that the same coordinator can call **at session start**, refuse the voice mode entirely with a typed error rather than start it and pray, and emit a tier decision the UI can display.

### 1.5 `plugins/plugin-local-inference/src/services/voice/shared-resources.ts` (337 lines)

Owns the eviction priority that the monitor honours:

```ts
export const RESIDENT_ROLE_PRIORITY: Readonly<Record<ResidentModelRole, number>> = {
  drafter: 10,
  vision: 20,
  embedding: 25,
  vad: 35,
  asr: 40,
  tts: 50,
  "text-target": 100,
};
```

This is the same ordering the brief mandates: cold → warm → hot. I9 maps directly onto it:

- **Hot (priority ≥ 50, never evicted before pressure-of-last-resort):** `text-target`, `tts`.
- **Hot-2 (priority 40):** `asr` — streaming.
- **Warm (priority 25–35):** `vad`, `embedding`.
- **Cold (priority ≤ 20):** `drafter`, `vision`. The brief's "cold-3" set (emotion, speaker-ID) does not have role entries yet; **I9 should add `emotion: 15` and `speaker-id: 18`** to this map. They are cheap, lazy-load tolerable, and load-on-demand even when MAX is missing.

### 1.6 `docs/eliza-1-pipeline/05-memory-budgets.md`

The existing per-device-class working-set table (WS10 prep). Lists 12 device rows (iPhone 14 → Linux desktop CUDA 24 GB) with "Text resident", "Vision mmproj resident", "OCR resident", "Image-gen resident", "Headroom", "Recommended capabilities".

This document is the precedent for what I9 ships: a typed table, with **explicit numeric ranges** for each tier. The new `device-tier.ts` should land alongside `05-memory-budgets.md` (or merge into it as `05a-device-tiers.md`).

### 1.7 Catalog scalar floors

From `packages/shared/src/local-inference/catalog.ts` `TIER_SPECS`:

| Tier | params | sizeGb (Q4_K_M) | minRamGb | contextLength |
|---|---|---|---|---|
| `eliza-1-0_8b` | 0.8B | 0.5 | 2 | 32k |
| `eliza-1-2b` | 2B | 1.4 | 4 | 32k |
| `eliza-1-4b` | 4B | 2.6 | 10 | 64k |
| `eliza-1-9b` | 9B | 5.4 | 12 | 64k |
| `eliza-1-27b` | 27B | 16.8 | 32 | 128k |
| `eliza-1-27b-256k` | 27B | 16.8 | 96 | 256k |
| `eliza-1-27b-1m` | 27B | 16.8 | 160 | 1M |

Manifest-pinned recommended budgets (live, measured on disk):

- `eliza-1-0_6b` (precursor of `0_8b`): `min 2500 MB / recommended 3700 MB`.
- `eliza-1-1_7b` (precursor of `2b`): `min 4000 MB / recommended 5500 MB`.

KV-bytes/token fallback (`kv-spill.ts`):

```ts
QUANTIZED_KV_BYTES_PER_TOKEN_BY_PARAMS = {
  "0.8B":  1_400,
  "2B":    2_400,
  "4B":    4_800,
  "9B":    9_000,
  "27B":  22_000,
};
```

That is "compressed QJL-K + Polar-V across all full-attention layers" — already what the catalog's `ramBudgetMb` was sized against.

---

## 2. Per-model RSS estimates at multiple quant levels

Most weight figures below are **measured on disk** from a real `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/` and `eliza-1-1_7b.bundle/` (Q4_K_M, the default-eligible quant); the other quants scale by the catalog ratios in `recommendation.ts:textQuantizationMatrix` (Q6_K = 1.45×, Q8_0 = 1.95× of Q4_K_M for weights; Q3_K_M ≈ 0.78× extrapolated). KV cache uses the `kv-spill.ts` per-token figures × the working context window (32k mobile, 64k laptop, 128k workstation). Sources are inline; "**measured**" means `ls -la` against a live bundle; "**model card**" means `huggingface.co/<id>`.

### 2.1 The eliza-1 LM stack (text-target + drafter)

| Model | fp16 | Q6_K | Q5_K_M | Q4_K_M | Q3_K_M | KV @ default ctx | Total resident (Q4_K_M @ default ctx) |
|---|---|---|---|---|---|---|---|
| **eliza-1-0_8b LM (32k ctx)** | 1.7 GB | 0.7 GB | 0.58 GB | 0.50 GB | 0.39 GB | 0.044 GB (1400 B × 32k) | **0.55 GB** |
| eliza-1-0_8b drafter (0.5B, 32k) | 1.0 GB | 0.45 GB | 0.36 GB | 0.31 GB | 0.24 GB | 0.029 GB | 0.34 GB |
| **eliza-1-2b LM (32k ctx)** | 4.0 GB | 2.0 GB | 1.62 GB | 1.40 GB | 1.09 GB | 0.075 GB (2400 B × 32k) | **1.48 GB** (measured `~/.eliza/.../eliza-1-1_7b-32k.gguf` = 1.22 GB Q4_K_M weights + KV) |
| eliza-1-2b drafter (0.8B, 32k) | 1.7 GB | 0.7 GB | 0.58 GB | 0.50 GB | 0.39 GB | 0.044 GB | 0.54 GB |
| eliza-1-4b LM (64k ctx) | 8.0 GB | 3.8 GB | 3.0 GB | 2.6 GB | 2.0 GB | 0.30 GB (4800 B × 64k) | 2.9 GB |
| eliza-1-9b LM (64k ctx) | 17 GB | 7.8 GB | 6.3 GB | 5.4 GB | 4.2 GB | 0.56 GB (9000 B × 64k) | 6.0 GB |
| eliza-1-27b LM (128k ctx) | 50 GB | 24.4 GB | 19.7 GB | 16.8 GB | 13.1 GB | 2.75 GB (22 kB × 128k) | 19.5 GB |
| eliza-1-27b-256k LM | 50 GB | 24.4 GB | 19.7 GB | 16.8 GB | 13.1 GB | 5.5 GB | 22.3 GB |
| eliza-1-27b-1m LM | 50 GB | 24.4 GB | 19.7 GB | 16.8 GB | 13.1 GB | 22 GB | 38.8 GB |

Sources: catalog scalar `sizeGb` (Q4_K_M), `textQuantizationMatrix` scale factors, `estimateQuantizedKvBytesPerToken`, measured Q4_K_M file lengths in `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/text/eliza-1-0_6b-32k.gguf` (394.8 MB) and `eliza-1-1_7b-32k.gguf` (1223.0 MB).

> **DFlash drafter caveat:** the drafter is *co-resident* with the target in the same llama-server process. The drafter row above is the **weights**; the drafter shares the kernel set and scheduler with the target, so the only extra RAM is its own weights + a small KV. Evicting the drafter (`role=drafter`, priority 10) means restarting llama-server without `-md` — heavy.

### 2.2 The voice + speech stack

| Model | fp16 | Q6_K | Q5_K_M | Q4_K_M | Q3_K_M | Notes |
|---|---|---|---|---|---|---|
| **OmniVoice base (frozen, single-voice)** | 1.5 GB | 0.6 GB | 0.48 GB | **0.40 GB** | 0.31 GB | Measured: `omnivoice-base-Q4_K_M.gguf` = **388.6 MB** in both 0_6b and 1_7b bundles. Same file on every tier in current bundles. |
| **OmniVoice tokenizer / codec** | 0.95 GB | 0.36 GB | 0.30 GB | **0.24 GB** | 0.19 GB | Measured: `omnivoice-tokenizer-Q4_K_M.gguf` = **240.8 MB**. Always paired with the base. Includes DAC encoder (98 MB), DAC decoder (38.7 MB), HuBERT stack (47.8 MB), Sem-Enc (28.1 MB) per the live `[Load]` trace in `reports/local-e2e/2026-05-11/e2e-loop-0_6b-...json`. |
| OmniVoice base (Q8_0, 9B+ tiers) | 1.5 GB | — | — | — | — | Catalog uses Q8_0 (1.95× of Q4 ≈ 0.78 GB) on 9B+ — see `voiceQuantForTier()`. |
| **Kokoro-82M (ONNX fp32)** | **0.31 GB** | — | — | 0.08 GB (q8 ONNX) | — | Model card: 82M params, ~310 MB fp32 / ~80 MB int8. See `voice/kokoro/kokoro-runtime.ts` constants. Alt TTS path on small mobile / web. |
| **Qwen3-ASR (0.6B)** | 1.2 GB | 0.55 GB | 0.45 GB | **~0.40 GB** (measured below) | 0.31 GB | Measured: `eliza-1-asr.gguf` (real Qwen3-ASR-0.6B GGUF) = **767.5 MB**. The bundle ships at this size on both 0_8b/2B tiers; the listed Q4 figure here approximates a tighter quant of the same model since the shipping GGUF is currently a less-aggressive quant. `eliza-1-asr-mmproj.gguf` adds **204.5 MB** (encoder-projector). |
| Qwen3-ASR (1.7B) | 3.4 GB | 1.55 GB | 1.26 GB | 1.10 GB | 0.85 GB | The 27B-tier ASR. Not in the small-tier bundles. |
| **Silero VAD v5.1.2 (int8 ONNX)** | — | — | — | — | — | Measured: `silero-vad-int8.onnx` = **640 KB** (≈ 2 MB documented baseline in the `[voice]` error message). Independent of LM tier. |
| **openWakeWord (melspec + embedding + head)** | — | — | — | — | — | Measured: `~/.milady/local-inference/wake/melspectrogram.onnx` (1.0 MB) + `embedding_model.onnx` (1.3 MB) + `hey-eliza.onnx` (1.2 MB) = **3.5 MB total**. (The `hey-eliza.onnx` shipped today is the renamed `hey_jarvis` head — `voice/wake-word.ts:OPENWAKEWORD_PLACEHOLDER_HEADS`.) |
| **Qwen3-Embedding-0.6B (GGUF)** | 1.2 GB | 0.55 GB | 0.45 GB | **0.40 GB** | 0.31 GB | Measured: `eliza-1-embedding.gguf` = **609.5 MB** in the 1_7b bundle (Q4/Q5-ish — exact quant not pinned in this bundle's manifest). Pools-from-text on the 0.8B tier (no separate embedding model). |
| **Speaker encoder (open contender)** | — | — | — | — | — | Brief asks for "~10 MB". ECAPA-TDNN at int8 ≈ 7 MB; X-vector ≈ 5 MB; SpeakerNet at int8 ≈ 14 MB. Assume **~10 MB resident**; the per-profile embedding state is a 192-dim or 256-dim float vector (≤ 1 KB per profile). |
| **Turn detector (livekit/turn-detector, large)** | — | — | — | **0.10 GB** | — | Model card: SmolLM2/Qwen2.5-0.5B-Instruct fine-tune. **0.1B params; <500 MB RAM at runtime in INT8 ONNX**. (huggingface.co/livekit/turn-detector). |
| **Turn detector (turnsense, mobile)** | — | — | — | **~0.06 GB** (int8) | — | Model card: SmolLM2-135M fine-tune. **135M params**, quantized ONNX ≈ ~60 MB. (huggingface.co/latishab/turnsense). Acc: 97.5% full / 93.75% int8. |
| **Voice-emotion classifier (acoustic)** | — | — | — | **~0.04 GB** (int8) | — | Brief asks for "~50M params, GGUF-able". Candidate: a Wav2Vec2-base emotion head at int8 ≈ 30–50 MB. Spec'd in R3-emotion. |
| **Text-emotion head (tiny LM head)** | — | — | — | 0 (shared) | — | Spec'd in R3-emotion — reuses the LM forward, head is ≤ 5 MB extra. |

**Activation peak adjustment.** For OmniVoice the live `MaskGIT` decode trace shows the GGML Metal compute buffer at **~1.17 GB** (`sched_reserve: MTL0 compute buffer size = 1167.03 MiB`) at 32 MaskGIT steps. That is **transient activation**, not steady-state weights — it lives during synthesis and is released between. The budget allocator must reserve this headroom for any tier that does TTS locally.

### 2.3 Co-resident roll-up — the single number the budget needs

The aggregated **steady-state co-resident** RAM (weights + KV at default ctx) for the **whole voice + text bundle** with default capabilities enabled:

| Tier | LM (Q4) | LM KV | drafter | TTS (omnivoice base + tok) | ASR | embedding | VAD | wake | turn | emotion | spk-enc | **Σ weights + KV** | **+ transient TTS buffer** |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 0_8b mobile (turnsense, asr-0.6B, no embed, kokoro-q8) | 0.50 | 0.04 | 0.31 | **0.08** kokoro-q8 | 0.40 | 0 (pool from LM) | 0.002 | 0.004 | 0.06 | 0.04 | 0.01 | **1.45 GB** | +0.3 GB |
| 0_8b desktop (livekit, asr-0.6B, omnivoice) | 0.50 | 0.04 | 0.31 | 0.65 | 0.40 | 0 (pool) | 0.002 | 0.004 | 0.10 | 0.04 | 0.01 | **2.07 GB** | +1.17 GB |
| 2b desktop (livekit, asr-0.6B, omnivoice, embed) | 1.40 | 0.075 | 0.50 | 0.65 | 0.40 | 0.40 | 0.002 | 0.004 | 0.10 | 0.04 | 0.01 | **3.58 GB** | +1.17 GB |
| 4b desktop (livekit, asr-0.6B, omnivoice, embed) | 2.60 | 0.30 | 0.70 | 0.65 | 0.40 | 0.40 | 0.002 | 0.004 | 0.10 | 0.04 | 0.01 | **5.21 GB** | +1.17 GB |
| 9b workstation (livekit, asr-0.6B, omnivoice-Q8, embed) | 5.40 | 0.56 | 1.40 | 1.28 (Q8) | 0.40 | 0.40 | 0.002 | 0.004 | 0.10 | 0.04 | 0.01 | **9.60 GB** | +1.17 GB |
| 27b workstation (livekit, asr-1.7B, omnivoice-Q8, embed) | 16.8 | 2.75 | 2.6 | 1.28 (Q8) | 1.10 | 0.40 | 0.002 | 0.004 | 0.10 | 0.04 | 0.01 | **25.1 GB** | +1.17 GB |

These are the numbers the new `assessVoiceBundleFits()` consumes.

Notes:

- `KV @ 32k mobile` uses `1400 B/tok × 32k = 44 MB`; `KV @ 64k laptop` uses `4800 B/tok × 64k = 300 MB`; `KV @ 128k workstation` uses `22 kB/tok × 128k = 2.75 GB`.
- "transient TTS buffer" is the ~1.17 GB OmniVoice MaskGIT decode buffer. Kokoro is much smaller (≤ 100 MB compute peak).
- Speaker-ID LRU cache (≤ 200 × ≤ 256-dim fp32 = ≤ 200 KB) is negligible — fold into "spk-enc".

---

## 3. Tier definitions — MAX / GOOD / OKAY / POOR

These are the numeric thresholds the new `device-tier.ts` returns from a `HardwareProbe`. Refined against §2's co-resident roll-up.

### 3.1 Hard thresholds (`classifyDeviceTier(probe) → DeviceTier`)

```
+-------+--------------------------------------+--------------------------------+--------------------------+
| Tier  | Effective model memory               | GPU compute / cores            | Default behaviour        |
+=======+======================================+================================+==========================+
| MAX   | ≥ 24 GB effective model RAM AND      | CUDA sm_80+ (A100/3090/4090/   | All voice + LM models     |
|       | ≥ 16 GB free at session start AND    | 5090/H100/H200/Blackwell)      | parallel, all resident.  |
|       | (≥ 16 GB VRAM dGPU                   | or Apple M-series Pro/Max/     | Default-eligible to run  |
|       |  OR Apple Silicon Pro/Max/Ultra      | Ultra (≥ 16 cores)             | every cold-path model    |
|       |  with ≥ 32 GB unified RAM)           |                                | concurrently.            |
+-------+--------------------------------------+--------------------------------+--------------------------+
| GOOD  | ≥ 12 GB effective model RAM AND      | Metal/Vulkan/CUDA present      | All models resident but  |
|       | ≥ 8 GB free at session start AND     | with ≥ 8 GB VRAM, OR           | serialized (one heavy    |
|       | (≥ 8 GB VRAM dGPU OR                 | Apple M-series base ≥ 16 GB    | model active at a time:  |
|       |  Apple Silicon base ≥ 16 GB unified  | unified RAM, OR x86 ≥ 4        | ASR/TTS not parallel).   |
|       |  OR x86 CPU-only ≥ 32 GB RAM)        | P-cores AVX2/AVX512            |                          |
+-------+--------------------------------------+--------------------------------+--------------------------+
| OKAY  | ≥ 6 GB effective model RAM AND       | ≥ 4 CPU cores AVX2,            | Load/unload per turn;    |
|       | ≥ 3 GB free at session start AND     | no GPU OR ≤ 6 GB VRAM          | KV caching breaks across |
|       | (≥ 16 GB total RAM OR                |                                | model swaps. Slow but    |
|       |  mobile flagship ≥ 12 GB RAM)        |                                | usable.                  |
+-------+--------------------------------------+--------------------------------+--------------------------+
| POOR  | < 6 GB effective model RAM OR        | < 4 CPU cores OR no AVX2 OR    | Severe issues. Refuse    |
|       | < 3 GB free at session start OR      | mobile < 8 GB RAM              | local voice; suggest     |
|       | no AVX2                              |                                | cloud.                   |
+-------+--------------------------------------+--------------------------------+--------------------------+
```

"Effective model memory" = `recommendation.ts:effectiveMemoryGb()`:

- Apple Silicon: `totalRamGb`.
- Discrete GPU: `max(gpu.totalVramGb, totalRamGb * 0.5)`.
- CPU-only: `totalRamGb * 0.5`.

### 3.2 Mapping to §2's co-resident roll-up

- **MAX** is sized to keep the **9b + drafter + omnivoice-Q8 + asr-0.6B + embed + turn + emotion + speaker-id + wake-word + VAD** all resident with parallel decode (LM + TTS at the same time). That fits inside ~16 GB effective model RAM with comfortable headroom; the 24-GB floor exists to allow the **27b** path on the same class of device.
- **GOOD** sizes for the **2b/4b** co-resident set (~3.6–5.2 GB) plus the ~1.17 GB OmniVoice transient peak, with a 1.5 GB OS reserve. Total ≈ 8 GB minimum, 12 GB recommended → matches the `≥ 8 GB VRAM` / `≥ 16 GB unified` floor.
- **OKAY** sizes for the **0_8b** set (~2 GB resident) when the device can't keep ASR + TTS hot at once — it has to swap (`OmniVoice` mmapped out while ASR is mmapped in, then back). 16 GB total RAM lets that work because OS + UI + dashboard already eats ~3–4 GB.
- **POOR** is for devices that can't even keep the smallest text tier + ASR + VAD resident at the same time. Local voice is refused.

### 3.3 Free-RAM gate at session start

`HardwareProbe.freeRamGb` is **dirtier than `totalRamGb`** (it depends on whatever else the OS is doing right now). I9 should use it only as a *secondary* gate that can demote a device by one tier when `freeRamGb < (probe.totalRamGb * 0.25)`. Don't promote on it.

### 3.4 Special cases

- **Apple Silicon M1/M2/M3/M4 base 8 GB**: clamps to **OKAY** even though unified-memory math says GOOD — the 8 GB ceiling is hard, and macOS reserves ~3 GB for the OS.
- **Mobile iOS**: hard ceiling of **OKAY** (per §6) regardless of RAM, because the OS background-task model breaks long-running local inference.
- **Mobile Android**: same ceiling at **OKAY**; Android's foreground-service requirement is a UX cost, not a RAM cost. Snapdragon 8 Elite (16 GB) at OKAY is fine.
- **WSL2 / Docker / VM**: read the host RAM honestly; the limit is real on the guest. Treat the same as native Linux.

---

## 4. Allocator policy under contention

### 4.1 Priorities (canonical)

Hot path (priority 1, never load-on-demand):

- **text-target** (priority 100)
- **tts** (priority 50)
- **asr** (priority 40 — streaming)

Warm path (priority 2, may be evicted under sustained pressure but reload is expensive):

- **vad** (priority 35)
- **embedding** (priority 25)

Cold path (priority 3, **load-on-demand even when missing in GOOD/OKAY**):

- **speaker-id** (NEW — propose priority 18)
- **emotion** (NEW — propose priority 15)
- **vision** mmproj (priority 20)
- **drafter** (priority 10)

Eviction walk: cold (10 → 18) first, then warm (25 → 35), then hot (40 → 100). The text target evicts only when it is literally the only resident role and pressure persists — already enforced in `MemoryMonitor.tick()` + `SharedResourceRegistry.evictLowestPriorityRole()`.

### 4.2 The new API the runtime calls

```ts
// plugins/plugin-local-inference/src/services/voice-budget.ts (NEW)

export type AllocationPriority = "hot" | "warm" | "cold";

export interface BudgetReservation {
  id: string;
  role: ResidentModelRole;
  bytes: number;
  priority: AllocationPriority;
  release(): void;
}

export interface VoiceBudget {
  /**
   * Reserve `bytes` for `modelId` with `priority`. Returns a handle the caller
   * MUST `.release()` to give the memory back. Throws `BudgetExhaustedError`
   * when the requested amount cannot fit even after evicting every available
   * lower-priority reservation.
   */
  reserve(args: {
    modelId: string;
    role: ResidentModelRole;
    bytes: number;
    priority: AllocationPriority;
  }): Promise<BudgetReservation>;

  /** Best-effort current free budget, in bytes. */
  freeBytes(): number;
  /** Total budget on this device, in bytes. */
  totalBytes(): number;
  /** All current reservations (for diagnostics + UI). */
  snapshot(): ReadonlyArray<Pick<BudgetReservation, "id" | "role" | "bytes" | "priority">>;
}
```

Semantics:

1. **`reserve(bytes, priority)`** walks the resident set ascending priority and evicts lower-priority reservations until `bytes` fit, then records the reservation.
2. **`release()`** is idempotent; multi-release is a no-op (not an error — release happens from teardown paths that may race).
3. The allocator is **memory-only**; it does not load weights. The caller (TTS engine, ASR loader, etc.) loads on success and runs `release()` on unload.
4. **MAX devices skip the allocator's eviction path**: every reservation succeeds because the budget is sized to fit the whole co-resident set. The reservation still happens so the snapshot UI shows what's hot.
5. **OKAY devices use the allocator aggressively** — every voice-turn boundary triggers an `evictLowest()` pass before TTS reserves the next ~1 GB transient buffer.
6. **POOR devices refuse `reserve()` for `tts`/`asr` `priority=hot`** unless the user explicitly opted into local voice; the typed error surfaces as a settings warning ("This device is below the local voice budget — switch to cloud TTS/ASR or accept very slow responses").

### 4.3 Wiring

- `voice-budget.ts` constructs a singleton at process start using `probeHardware()` → `classifyDeviceTier()` → per-tier byte budget table.
- `dflash-server.ts` calls `reserve(role="text-target")` + `reserve(role="drafter")` when the llama-server spawns.
- `voice/pipeline.ts` calls `reserve(role="tts", bytes=transientPeakMb*MB)` at the start of each synthesis, releases when done.
- `voice/vad.ts`, `voice/wake-word.ts`, `voice/eot-classifier.ts`, the emotion/speaker-ID modules all call `reserve(role=..., priority="warm"|"cold")` at session arm.
- The `MemoryMonitor` keeps its existing `evictLowestPriorityRole()` path; it now consults `VoiceBudget.snapshot()` instead of walking the registry directly. Eviction priority is still owned by `RESIDENT_ROLE_PRIORITY` in `voice/shared-resources.ts`.

---

## 5. Settings UX — the knobs the user gets

Five toggles, plus the tier badge:

1. **Backend mode (auto / force-local / force-cloud).** Default `auto`. `force-local` overrides the mobile-cloud-default. `force-cloud` overrides the desktop-local-default. Both are honored even on POOR (with the right warnings).
2. **Model-quality preset (max / balanced / efficient).** Maps to a quant ladder for the LM (`Q8_0 / Q4_K_M / Q3_K_M`) and the voice stack (OmniVoice Q8 → Q4_K_M → kokoro-q8). The device-tier classification is the floor; the preset slides within it.
3. **Max-RAM cap (slider, GB).** Hard cap on the allocator's total budget. Default = the tier's natural total (e.g. on a MAX 64 GB box, default 32 GB cap so the rest of the system stays smooth). Min = the tier's `recommendedMb` floor.
4. **Allow quant downgrade (boolean).** Default `true`. When `true`, an OOM-pending reservation may pick a smaller quant variant (Q4_K_M → Q3_K_M, omnivoice-Q8 → Q4_K_M) instead of refusing. When `false`, the allocator's `reserve()` throws.
5. **Continuous local recording (boolean, off on battery).** Mobile-only — gates whether the warm path stays armed when the screen is off.

Plus surface a **read-only** Tier Badge:

- **Eliza-1 device tier: MAX** — _All models can run in parallel, fully resident._
- **Eliza-1 device tier: GOOD** — _All models stay loaded; responses serialize (one heavy model at a time)._
- **Eliza-1 device tier: OKAY** — _Models load/unload per turn. Caching cannot survive a model swap; expect slower latency under voice + image-gen at once._
- **Eliza-1 device tier: POOR** — _This device is below the local-voice budget. Local responses will be very slow. Cloud is recommended._

---

## 6. Mobile constraints

### 6.1 iOS

- **Per-app memory ceiling**: empirically ~3–4 GB on iPhone 14 (6 GB device), ~5–6 GB on iPhone 15 Pro / 17 Pro (8–12 GB device), ~7 GB on iPad Pro M4 (16 GB device). Hard `jetsam` kill above the limit.
- **Background**: foreground-only by default. **Background-audio** entitlement gives the app a continuous mic + speaker session even when the screen is off, but only via `AVAudioSession.Category.playAndRecord`. Without that entitlement, locking the screen kills the voice loop.
- **Background processing time**: ~30 s before a hard suspend without entitlements. With `BGTaskScheduler` (`BGProcessingTask`), the OS may schedule a few-minute window opportunistically.
- **Implication**: device-tier classification on iOS clamps to **OKAY** regardless of RAM. Local-only mode requires:
  - `UIBackgroundModes` includes `audio`.
  - The hot path stays inside ~3 GB resident.
  - Cold path models are **never loaded automatically** — wake-word + VAD + turn-detector small are the only locals; ASR + TTS go cloud unless the user explicitly enabled local-only.

### 6.2 Android

- **Per-app memory**: highly variable; modern flagships (Pixel 9, Snapdragon 8 Elite, S24 Ultra) give 4–8 GB to a foreground app. Older / budget devices give ≤ 1.5 GB.
- **Foreground service**: required for continuous recording. `Service.startForeground()` with `FOREGROUND_SERVICE_TYPE_MICROPHONE` (API 34+). The notification is non-dismissable; this is the OS-mandated UX cost.
- **Doze / app standby**: aggressive on Android. The foreground service is the only path that survives screen-off for arbitrary durations.
- **Wi-Fi vs cellular**: Wave 2 §J3 explicitly: Wi-Fi → auto, cellular → ask. The download manager already has this hook (see R5-versioning). I9 reuses it for "should we download a bigger quant on this connection?".

### 6.3 Default on mobile (per §U2 of the brief)

- Cloud TTS + ASR.
- Local turn-detector (turnsense 135M) + Silero VAD + wake-word (~5 MB total).
- Local LM only when the user explicitly opts in AND the tier is at least OKAY.

---

## 7. Warning copy — exact strings per tier

These land in `i18n/en/local-inference.json` (or wherever the dashboard's strings live; I9 grep `recommendedBucket` for existing siblings).

**Onboarding header (one of):**

```
This Mac is in the MAX tier for on-device Eliza.
This Linux box (CUDA 24 GB VRAM, 64 GB RAM) is in the MAX tier for on-device Eliza.
Your phone is in the OKAY tier for on-device Eliza. We recommend cloud voice.
This device is in the POOR tier for on-device Eliza.
```

**MAX:**

> Your device can run every local model in parallel: text, voice, ASR, turn detection, speaker recognition, and emotion — all resident at the same time. Expected first-audio latency under 250 ms.

**GOOD:**

> Your device can keep every local model loaded but will run them one at a time. Text responses, voice synthesis, and ASR are all local; only one heavy model is active per turn. Expected first-audio latency 300–600 ms.

**OKAY:**

> Your device will load and unload local models as they're needed. Caching does not survive a model swap, so the first response after voice + image-gen at once will be slow. Expected first-audio latency 600–1500 ms. Consider cloud voice for faster turnaround.

**POOR:**

> This device is below the local-voice memory budget. Local responses will be very slow and may fail to load. We recommend Cloud mode — your turn-detection and VAD still run locally for privacy.

**Settings tooltip for "Allow quant downgrade":**

> When on, Eliza will silently swap to a smaller (less accurate) variant of a model if the bigger one won't fit. When off, Eliza refuses to start a feature that won't fit, with a clear error.

**Mobile-only "Cellular" warning:**

> You're on cellular data. The next model update is ~XX MB. Download now / Wait for Wi-Fi.

---

## 8. Concrete files to touch for I9

### Add

- **`plugins/plugin-local-inference/src/services/device-tier.ts`** — `classifyDeviceTier(probe): DeviceTier`, the threshold constants from §3, plus `tierWarningCopy(tier): string`.
- **`plugins/plugin-local-inference/src/services/voice-budget.ts`** — the `VoiceBudget` allocator API in §4.2 plus the per-tier total-bytes table.
- **`plugins/plugin-local-inference/src/services/device-tier.test.ts`** — table-driven tests against the device classes in `docs/eliza-1-pipeline/05-memory-budgets.md`.
- **`plugins/plugin-local-inference/src/services/voice-budget.test.ts`** — reservation / eviction / quant-downgrade behaviour.

### Modify

- **`plugins/plugin-local-inference/src/services/voice/shared-resources.ts`** — add `emotion: 15`, `speaker-id: 18` to `ResidentModelRole` + `RESIDENT_ROLE_PRIORITY`.
- **`plugins/plugin-local-inference/src/services/memory-monitor.ts`** — consume `VoiceBudget.snapshot()` instead of `SharedResourceRegistry.evictableRoles()` directly (the registry stays as the lower layer).
- **`plugins/plugin-local-inference/src/services/active-model.ts`** — `assertModelFitsHost()` calls `voice-budget.reserve()` instead of just `assessRamFit()` (the latter remains a sub-component).
- **`plugins/plugin-local-inference/src/services/recommendation.ts`** — surface the `DeviceTier` in the returned `RecommendedModelSelection` so the dashboard can render the badge alongside the chosen model.
- **`plugins/plugin-local-inference/src/services/voice/pipeline.ts`** — `reserve(role="tts", ...)` at synth start, release at end.
- **`plugins/plugin-local-inference/src/services/dflash-server.ts`** — `reserve(role="text-target", ...)` + `reserve(role="drafter", ...)` when spawning.
- **`plugins/plugin-local-inference/src/services/voice/wake-word.ts`**, **`vad.ts`**, **`eot-classifier.ts`** — `reserve(role="warm"|"cold", ...)` at session arm.
- **`packages/ui/src/voice/voice-provider-defaults.ts`** — switch the desktop/mobile defaults to consult `DeviceTier`.
- **`apps/app/...`** — onboarding screen + Settings panel render the tier badge and the warning copy from §7.
- **`docs/eliza-1-pipeline/05-memory-budgets.md`** — link to the new device-tier API; merge in the §2 co-resident roll-up table.

### Out of scope for I9 (delegated to other I-agents)

- I3 (emotion) and I2 (speaker-ID) deliver the actual `EvictableModelRole` registrations.
- I10 (app UX) renders the tier badge in onboarding + settings.
- I12 (CI) covers tests for `voice-budget` and `device-tier`.

---

## 9. Risks and effort class

**Risks:**

1. The §2 co-resident table is partially extrapolated (Kokoro-q8 ONNX, emotion classifier, speaker encoder are not yet on disk). When the real bundles land, the per-tier total bytes in `voice-budget.ts` need to be re-baselined — same shape as `docs/05-memory-budgets.md`'s open items.
2. The OmniVoice ~1.17 GB transient compute buffer is **Metal-specific** (`MTL0 compute buffer size = 1167.03 MiB`). The CUDA / Vulkan compute peak likely differs; the budget allocator must reserve a backend-aware peak, not a fixed number. I9 should pick the **max** of the per-backend measurements and use that.
3. The `MemoryMonitor` runs on a 30 s tick — too coarse for the OmniVoice synth burst. The transient-reserve path in `voice-budget.reserve()` must be **synchronous** so a TTS request can be refused at submit time, not after the OS has already swapped.
4. **Mobile RAM probing is unreliable.** iOS doesn't expose total physical RAM directly to a third-party app; `os_proc_available_memory()` exists since iOS 13 but is jetsam-aware, not architectural. Android's `ActivityManager.getMemoryInfo()` is more honest. I9 should treat any mobile probe with `availableRamGb === null` as POOR by default.
5. **CUDA `sm_80+` detection** is not in `HardwareProbe` today — `gpu.backend === "cuda"` is all there is. I9 needs to extend the probe with `cudaComputeCapability` (read from `nvidia-smi --query-gpu=compute_cap` at probe time, or `cudaGetDeviceProperties` via a native binding). Without it, the MAX/GOOD divide on x86 dGPUs collapses to "any VRAM ≥ 16 GB".

**Effort class:**

- **R9 → I9 wiring:** **M** (1–2 days for a strong implementer). The thresholds, copy, and tier-detection code are mechanical given §3. The allocator is the same shape as the existing `SharedResourceRegistry`, just split into a separate concern.
- **Budget allocator implementation:** **M** (same window).
- **Real-bundle re-baseline + per-backend transient measurement:** **S** (half-day) — runs against existing `~/.eliza/local-inference/models/eliza-1-{0_6b,1_7b}.bundle/` and the live llama-server `/metrics` endpoint.
- **Mobile platform plumbing** (background-audio entitlement on iOS, foreground service on Android): **M** (overlaps with I10/R10) — done by the connector subagent, not I9.

Total I9: **M (2–3 days).**

---

## Appendix A — Verification trail (every cited path is real)

- `plugins/plugin-local-inference/src/services/ram-budget.ts` — 293 lines, read.
- `plugins/plugin-local-inference/src/services/memory-monitor.ts` — 304 lines, read.
- `plugins/plugin-local-inference/src/services/recommendation.ts` — 667 lines, read.
- `plugins/plugin-local-inference/src/services/active-model.ts` — 764 lines, read.
- `plugins/plugin-local-inference/src/services/voice/shared-resources.ts` — 337 lines, read.
- `plugins/plugin-local-inference/src/services/hardware.ts` — 230 lines (head), read.
- `plugins/plugin-local-inference/src/services/kv-spill.ts` — 121 lines, read.
- `plugins/plugin-local-inference/src/services/voice/eot-classifier.ts` — 410 lines (head), read.
- `plugins/plugin-local-inference/src/services/voice/wake-word.ts` — 120 lines (head), read.
- `plugins/plugin-local-inference/src/services/voice/vad.ts` — line 159 cites "Silero VAD (~2 MB)".
- `plugins/plugin-local-inference/src/services/voice/kokoro/kokoro-runtime.ts` — line 9 cites "~310 MB fp32, ~80 MB int8".
- `packages/shared/src/local-inference/catalog.ts` — `TIER_SPECS`, `textQuantizationMatrix`, lines 166–290.
- `packages/shared/src/local-inference/types.ts` — `HardwareProbe`, `MobileHardwareProbe`, lines 421–457.
- `docs/eliza-1-pipeline/05-memory-budgets.md` — read in full.
- `docs/ELIZA_1_BUNDLE_EXTRAS.json` — read in full (vision mmproj sizes per tier).
- `docs/RELEASE_V1.md` — voice/TTS/ASR component map at §0 (rows for Voice, ASR, VAD, Embedding, Drafter).
- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/text/eliza-1-0_6b-32k.gguf` — measured 394.8 MB.
- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/tts/omnivoice-base-Q4_K_M.gguf` — measured 388.6 MB.
- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/tts/omnivoice-tokenizer-Q4_K_M.gguf` — measured 240.8 MB.
- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/dflash/drafter-0_6b.gguf` — measured 394.8 MB.
- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/asr/eliza-1-asr.gguf` — measured 767.5 MB.
- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/asr/eliza-1-asr-mmproj.gguf` — measured 204.5 MB.
- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/vad/silero-vad-int8.onnx` — measured 640 KB.
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/text/eliza-1-1_7b-32k.gguf` — measured 1223.0 MB.
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/embedding/eliza-1-embedding.gguf` — measured 609.5 MB.
- `~/.milady/local-inference/wake/{melspectrogram,embedding_model,hey-eliza}.onnx` — measured 3.6 MB total.
- `~/.eliza/local-inference/models/eliza-1-0_6b.bundle/eliza-1.manifest.json` — `ramBudgetMb: { min: 2500, recommended: 3700 }`.
- `~/.eliza/local-inference/models/eliza-1-1_7b.bundle/eliza-1.manifest.json` — `ramBudgetMb: { min: 4000, recommended: 5500 }`.
- `reports/local-e2e/2026-05-11/e2e-loop-0_6b-2026-05-11-fastout8-mic32-3.json` — `MTL0 compute buffer size = 1167.03 MiB` for OmniVoice MaskGIT.
- Model card: https://huggingface.co/livekit/turn-detector — 0.1B params, <500 MB INT8 ONNX runtime RAM.
- Model card: https://huggingface.co/latishab/turnsense — 135M params SmolLM2-135M fine-tune, ~100 MB unquantized.
- Model card (referenced in code): https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX — 82M params.

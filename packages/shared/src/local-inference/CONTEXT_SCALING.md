# Eliza-1 context-length scaling: how far can we push the window on real machines?

This is the analysis behind the per-tier `contextLength` in `catalog.ts`, the
`dflash.{contextSize,draftContextSize}` knobs in `runtimeFor()`, and the
RAM-budget / spill plumbing in `ram-budget.ts` + `kv-spill.ts`. It answers one
question: **given a phone / 16 GB GPU / 24 GB GPU and an Eliza-1 tier, what is
the largest context window that actually fits, and which optimization should run
when there is spare memory vs when there isn't?**

The short version: the active text line is Qwen3.5 for 0.8B/2B/4B/9B and
Qwen3.6 for 27B. These hybrid-attention models have large native context
metadata, but the catalog intentionally ships conservative, verified GGUF
windows: 32k for 0.8B/2B, 64k for 4B/9B, 128k for 27B, and 256k for the
27B-256k variant. KV-cache memory is still the runtime limiter on high-context
hosts, and QJL+TurboQuant/PolarQuant plus spill are the levers. The missing
runtime feature is a memory-aware context selector that chooses the largest
verified model+context pair that fits the device.

---

## 1. The geometry

KV-cache footprint per generated token, summed over all full-attention layers:

```
bytes/token  =  n_layers * n_kv_heads * head_dim * (k_bits + v_bits) / 8
```

Qwen3.5/Qwen3.6 hybrid base shapes (from each base model's `config.json`; the
registry's `model_registry.py` table is the source of truth). `kv layers` means
full-attention layers that actually allocate a KV cache; Gated DeltaNet layers
carry recurrent state instead.

| Eliza-1 tier      | base model              | kv layers | kv heads | head_dim | catalog ctx | native ctx | GGUF (quant)        |
| ----------------- | ----------------------- | --------: | -------: | -------: | ----------: | ---------: | ------------------- |
| `eliza-1-0_8b`    | Qwen3.5-0.8B-Base       |         6 |        2 |      256 |         32k |       256k | ~0.5 GB (Q4-class)  |
| `eliza-1-2b`      | Qwen3.5-2B-Base         |         6 |        2 |      256 |         32k |       256k | ~1.4 GB (Q4-class)  |
| `eliza-1-4b`      | Qwen3.5-4B-Base         |         7 |        2 |      256 |         64k |       256k | ~2.6 GB (Q4_K_M)    |
| `eliza-1-9b`      | Qwen3.5-9B-Base         |         8 |        4 |      256 |         64k |       256k | ~5.4 GB (Q4_K_M)    |
| `eliza-1-27b`     | Qwen3.6-27B             |        16 |        4 |      256 |        128k |       256k | ~16.8 GB (Q4_K_M)   |
| `eliza-1-27b-256k`| Qwen3.6-27B             |        16 |        4 |      256 |        256k |       256k | ~16.8 GB (Q4_K_M)   |

The upstream Qwen3.6 27B card also documents extension toward roughly 1M
tokens, but Eliza-1 does not publish a 1M catalog tier until the GGUF, backend
evidence, and mobile/desktop smoke artifacts exist.

Bits-per-coordinate per cache layout (what the dflash-server actually loads —
see `kvCacheForContext()` in `catalog.ts`):

| layout                       | K bits/coord | V bits/coord | combined B/coord | notes                                                          |
| ---------------------------- | -----------: | -----------: | ---------------: | -------------------------------------------------------------- |
| `f16`                        |         16.0 |         16.0 |             4.00 | stock llama.cpp default                                         |
| `q8_0`                       |          8.5 |          8.5 |             2.12 | stock; lossless-ish                                            |
| `qjl1_256` K + `turbo3_0` V  |        ~2.13 |         ~3.5 |             ~0.70 | the ≤8k-context **fallback** layout (TBQ3 V)                    |
| `qjl1_256` K + `q4_polar` V  |        ~2.13 |         ~4.5 |             ~0.83 | **the default for every shipping tier** (all are >8k context)   |

QJL on the K-cache realizes ~7.53× vs f16 — *not* the marketing 16× — because
each 256-coord sketch block carries a per-token bf16 norm (≈34 bytes of
overhead per block of 256 sketch dims). PolarQuant on the V-cache is ~4-bit +
per-block scales. These are the figures `model_registry._compute_inference_mem`
and `kv-spill.estimateQuantizedKvBytesPerToken` are both sized against
(`QUANTIZED_KV_BYTES_PER_TOKEN_BY_PARAMS` = 1200 / 2400 / 9000 / 22000 B/tok for
0.8B / 2B/9B/27B — consistent with the per-layer math here once you account for
the realized ratios).

Resulting **bytes/token across the whole KV cache**:

| tier  | f16      | q8_0     | qjl+turbo3 (≤8k fallback) | qjl+polarq4 (**shipping default**) |
| ----- | -------: | -------: | ------------------------: | ---------------------------------: |
| 0.8B  |  12.3 kB |  6.5 kB  |                   ~2.2 kB |                            ~2.5 kB |
| 2B    |  12.3 kB |  6.5 kB  |                   ~2.2 kB |                            ~2.5 kB |
| 4B    |  14.3 kB |  7.6 kB  |                   ~2.5 kB |                            ~3.0 kB |
| 9B    |  32.8 kB | 17.4 kB  |                   ~5.8 kB |                            ~6.8 kB |
| 27B   |  65.5 kB | 34.8 kB  |                  ~11.5 kB |                           ~13.6 kB |

The small tiers are cheap per token because only 6-7 layers carry a KV cache;
the rest are linear-attention/recurrent-state blocks.

---

## 2. Max context that fits the KV cache, by device

Budget model: `available_for_KV = device_mem − GGUF_weights − working_set`,
where working_set is the compute/activation/scratch buffers (≈0.6 GB for 0.8B,
0.8 GB for 2B, 1.0 GB for 4B, 1.5 GB for 9B, 2.5 GB for 27B). For RAM-budget
hosts (phones, Apple Silicon, CPU) subtract another ~1.5 GB OS reserve
(`DEFAULT_RAM_HEADROOM_RESERVE_MB`); the GPU columns assume dedicated VRAM.
Numbers are "context tokens the cache can hold", rounded.

### Phones — ~4 GB usable / ~8 GB usable

| tier  | layout         |  4 GB | 8 GB  |
| ----- | -------------- | ----: | ----: |
| 0.8B  | f16            |  ~27k |  ~65k |
| 0.8B  | **qjl+polarq4**| ~131k | ~312k |
| 2B  | f16            |  ~19k |  ~56k |
| 2B  | **qjl+polarq4**|  ~90k | ~271k |
| 4B    | f16            |   —   |  ~32k |
| 4B    | **qjl+polarq4**|  ~14k | ~155k |
| 9B    | qjl+polarq4    |   —   | ~174k |

Takeaway: the small tiers have enough compressed-KV headroom that verified
release evidence, not raw KV capacity, should decide whether a wider context
variant is offered. The 2B is comfortable on any modern (>=6 GB) phone. The 4B
is an 8 GB+ phone/tablet tier, and 9B should stay behind the 12 GB RAM gate.

### Gaming / workstation GPUs — 16 GB / 24 GB VRAM

| tier  | layout          | 16 GB | 24 GB |
| ----- | --------------- | ----: | ----: |
| 0.8B  | f16             | ~139k | ~214k |
| 0.8B  | q8_0            | ~263k | ~404k |
| 0.8B  | **qjl+polarq4** | ~674k | ~1.0M |
| 2B  | f16             | ~131k | ~206k |
| 2B  | **qjl+polarq4** | ~633k | ~995k |
| 4B    | f16             |  ~90k | ~149k |
| 4B    | **qjl+polarq4** | ~436k | ~718k |
| 9B    | f16             | ~298k | ~560k |
| 9B    | **qjl+polarq4** |  ~1.4M | ~2.7M |
| 27B   | f16             |   —   |  ~77k |
| 27B   | q8_0            |   —   | ~145k |
| 27B   | **qjl+polarq4** |   —   | ~372k |

Takeaways:

- **The 27B does not fit on 16 GB at all** — weights alone are ~16.8 GB. Its
  16 GB story is "use the 9B instead", which the recommender ladder already
  encodes. On 24 GB the 27B fits with ~5 GB to spare → ~370k context at the
  compressed cache, ~145k even at q8_0, ~77k at f16. The 27B's `128k` catalog
  default is the right call for 24 GB; `27b-256k`'s `minRamGb: 96` correctly
  keeps it off consumer cards.
- **The 9B is the sweet spot for 16 GB cards.** Weights ~5.4 GB leaves ~9 GB
  for KV → it fits its `65536` catalog window with ~8.6 GB of headroom even at
  *f16* KV. The compressed cache would let the 9B run up to 256k tokens on 16 GB if
  the weights supported it (they don't natively yet — see "RoPE extension").
- **0.8B / 2B on a 16-24 GB GPU are latency/throughput choices, not memory
  choices.** Weights are 0.5-1.4 GB and compressed KV at 32k is tiny on those
  cards, so the spare memory should buy f16/q8 KV, bigger drafters, or more
  concurrent contexts rather than pretending an unverified longer GGUF is
  release-ready.

---

## 3. Wins

Ranked by confidence × impact.

### HIGH — ship a memory-aware *context* selector (the real gap)

Today `recommendation.ts` picks a *model* per device, and `pickFittingContextVariant`
picks among *pre-baked context variants of the same model line* (`27b` / `27b-256k`
). There is no path that says "the device has 14 GB of unused VRAM
after loading the 0.8B at its default 32k — bump `contextSize` toward the
model's native ceiling". The numbers above show every device has slack:

- 0.8B / 2B: the catalog's `32768` is the verified shipping window. A
  memory-aware selector can raise runtime context only after the exact GGUF
  variant has passed the same backend/e2e evidence as the catalog default.
- 9B: catalog `65536`. Native range extends to 128k+ for the RoPE-extended
  variant. On 16 GB the compressed KV at 128k is ~0.8 GiB — trivially fits. A
  `9b-128k` variant (when the weights exist) would be a 16 GB-friendly long-
  context tier.
- 27B: catalog `131072` on 24 GB uses ~1.7 GiB compressed KV. There's room for
  ~370k. `27b-256k` already covers that but is gated to 96 GB by `minRamGb` —
  arguably it could surface on 24 GB GPUs (weights 16.8 + 2.5 working + 3.4 KV
  at 256k ≈ 22.7 GB, tight but real). Lower-risk: keep the gate, add a
  "stretch 27b to ~200k via runtime `contextSize` when VRAM ≥ 24 GB" path.

**Implementation sketch:** after the model is chosen, compute
`maxFittingContext = floor((memBytes − weightBytes − workingSet) / kvBytesPerToken)`
using the same `estimateQuantizedKvBytesPerToken` figure `kv-spill.ts` uses,
clamp to `min(model.contextLength, baseModelNativeContext)`, and pass that as
`dflash.contextSize` instead of the static `contextLength`. This is the
"largest model+context combo that fits the available RAM/VRAM with a safety
margin, preferring qjl+polarq4" the task asks for.

### HIGH — default to the compressed cache whenever context > 8k (already done, keep it)

`kvCacheForContext()` already returns `{ typeK: "qjl1_256", typeV: "q4_polar" }`
for any context > 8192, and every shipping tier is > 8k. The memory-aware
selector must keep using that compressed layout for fit checks unless the user
explicitly chooses an accuracy-first KV policy with enough headroom.

### RESOLVED — `eliza-1-4b` is in `catalog.ts`

`model_registry.py` has a real, buildable `qwen3.5-4b` → `eliza-1-4b` entry; the
catalog now includes the 4B tier at `elizaos/eliza-1/bundles/4b`. The 4B fits
an 8 GB phone when the compressed cache path is available and is a strong
16 GB-GPU default.

### MEDIUM — `27b-256k` could surface on 24 GB GPUs

Today `minRamGb: 96` means it only appears on 96 GB+ Apple Silicon / servers.
The math says 256k at the compressed cache fits ~22.7 GB on a 24 GB card —
tight, but it works, and it degrades gracefully via KV spill to host RAM past
that. Lower the gate to ~`minRamGb: 24` *only if* the on-device verify pass
confirms the spill path meets the text latency budget; otherwise leave it.

### LOW / informational — no unverified catalog `contextLength` bump

It is tempting to read the KV math and bump `contextLength` from 32768 to a huge
number. Don't. The catalog is a release contract, not a theoretical shape
calculator. A wider 0.8B/2B/4B/9B GGUF should be added only as a separate
variant after the GGUF, backend verification, local inference smoke, and
manifest evidence exist.

---

## 4. The mobile story

How the catalog/harness handles low-RAM hosts today:

- `FIRST_RUN_DEFAULT_MODEL_ID = "eliza-1-2b"` — the smallest tier that fits
  "the broadest range of hardware (modern phone or laptop)". On first run with
  no preference, that's what loads.
- Hosts that can't fit `eliza-1-2b` fall back to `eliza-1-0_8b` via the
  `mobile` ladder in `recommendation.ts`: `TEXT_SMALL: [0_8b, 2b]`,
  `TEXT_LARGE: [2b, 0_8b]`. `canFit` runs `assessRamFit` against the device's
  *total* RAM (mobile shares GPU memory with system RAM), with the OS headroom
  reserve and a download-size guardrail (`wontFitRatio 0.8`, `tightRatio 0.65`).
- `assessRamFit` → `resolveRamBudget`: for an installed Eliza-1 bundle it reads
  `ramBudgetMb.{min,recommended}` from `eliza-1.manifest.json`; otherwise it
  synthesizes `recommendedMb = minRamGb + (compressed KV bytes/token ×
  contextLength)`. So "boots" and "runs a long session comfortably" are
  genuinely different lines, sized off the *compressed* KV footprint.
- Past 64k context on a device whose RAM can't hold the cache, `kv-spill.ts`
  pages cold KV out to host RAM (`cpu`) or NVMe (`disk`), keeping the hot tail
  resident — but it **hard-fails with `KvSpillUnsupportedError`** if the
  worst-case cold-page restore (one 256-token page over PCIe ≈12 GB/s, or NVMe
  ≈1.5 GB/s) can't meet the latency budget (200 ms voice / 1500 ms text). No
  silent-slow fallback. On phones there is no discrete GPU, so the restore
  class is `disk-nvme`: a 0.8B page is ~5 MB ÷ 1.5 GB/s ≈ 3.4 ms — fine for
  text, fine for voice. Spill is viable on phones; it just rarely *triggers*
  because the verified mobile tiers currently ship modest 32k/64k contexts and
  the compressed cache for those windows is small.

**What's missing on mobile:** the same memory-aware context selector. A 4 GB
phone running 0.8B at the catalog's static 32k is fine; an 8 GB phone can often
move to 4B. The selector should enumerate tiers fitting the device, pick the
largest verified tier, and then pick `contextSize = min(tier.contextLength,
maxFittingContextAtCompressedCache - safetyMargin)`.

---

## 5. The overhead-aware policy: VRAM/RAM budget → config

The user's framing: "optimizations that run when we have extra overhead vs when
we can't." A 24 GB GPU running a 0.8B has ~22 GB of spare VRAM — that slack can
buy a *bigger model*, a *bigger context*, a *more accurate KV cache (f16)*, a
*bigger speculative drafter*, or *more parallel contexts* (continuous batching).
A 4 GB phone has none of that — smallest model, most aggressive KV quant, KV
spill armed. Decision table (after a tier is chosen for the device, working out
what to do with the remaining headroom):

| device / situation                              | model         | KV layout            | context (runtime `contextSize`)            | drafter / spec-decode             | parallelism (`optimizations.parallel`) | spill        |
| ----------------------------------------------- | ------------- | -------------------- | ------------------------------------------ | --------------------------------- | --------------------------------------: | ------------ |
| Phone, ~4 GB usable                             | 0.8B          | qjl+polarq4 (forced) | 32768 verified catalog window               | no drafter on 0.8B by policy      | 4 (or 2 if KV is the squeeze)           | armed (disk-nvme); hard-fail if >1.5 s |
| Phone, ~6-8 GB usable                           | 2B (or 4B*) | qjl+polarq4          | 32768 for 2B; 65536 for 4B if it fits       | drafter on for 2B+                | 4                                       | armed        |
| Phone/tablet, 12 GB+ RAM                         | 9B            | qjl+polarq4          | up to 65536 (catalog) — fits easily         | 9B-distilled drafter              | 4                                       | rarely needed |
| 16 GB GPU                                        | **9B**        | qjl+polarq4 (or **f16** — 16 GB fits f16 KV at 64k with 8.6 GB to spare → use f16 for accuracy) | 65536; could stretch to 128k on a RoPE-ext variant | drafter on, ngl=max, draftGpuLayers=max | 4-8 | not needed |
| 16 GB GPU, **want long context** on small model | 2B / 4B      | qjl+polarq4          | verified catalog window; add wider variants only after evidence | drafter on                        | 8 (lots of room → continuous batching)  | n/a          |
| 24 GB GPU                                        | **27B**       | qjl+polarq4 (f16 only fits ~77k — keep compressed) | 131072 (catalog); stretch toward ~200k if verify ok | 9B-distilled drafter, ngl=max | 8 | armed past ~200k |
| 24 GB GPU, small model on purpose (latency)     | 0.8B / 2B   | **f16** or q8_0 if accuracy-first | verified catalog window; or run multiple parallel sessions | **bigger drafter** only for 2B+ targets | 8 | n/a |
| 48 GB+ Apple Silicon (unified)                  | 27B           | qjl+polarq4          | 131072 → 262144 (`27b-256k` if RAM ≥ 96 GB) | 9B drafter                        | 8                                       | unified-mem spill cheap |
| 96 GB+ / GH200                                  | 27B-256k       | qjl+polarq4 / TCQ trellis | 262144                | 9B drafter, mlock on                    | 8                                       | native max context |

The levers, in priority order, when there's spare memory:

1. **Bigger model first.** A 9B at 16 GB beats a 2B at 16 GB for quality;
   pick the largest tier that fits with margin. (This is what the ladders do.)
2. **Then bigger context.** Raise runtime `contextSize` toward
   `min(tier.contextLength, baseNativeContext, maxFittingContext)`. Cheap with
   the compressed cache.
3. **Then more accurate KV** (f16 / q8_0) — only worth it when there's enough
   slack to hold f16 *and* the chosen context, which on consumer cards means
   the 0.8B / 2B/9B tiers, not the 27B. `kvCacheForContext` would need a
   `preferAccurateKvWhenHeadroom` branch keyed off probed VRAM.
4. **Then a bigger drafter** (better acceptance rate → faster decode) — e.g.
   the 2B distilled drafter in front of the 0.8B target, or the existing 9B
   drafter in front of the 27B. Already wired (`runtimeFor` sets
   `draftGpuLayers: "auto"`); only the *choice* of drafter is fixed today.
5. **Then more parallel contexts** — `optimizations.parallel` is already
   `8` for ≥131072-context tiers and `4` otherwise; on a roomy device serving a
   small model it could be 8 regardless, enabling continuous batching for
   multiple concurrent sessions.

When there's *no* slack (phones): smallest model, `qjl+polarq4` forced (already
the default >8k), `contextSize` = whatever fits, KV spill armed but expected to
rarely fire, `parallel` dropped to 2 if the KV cache is the squeeze. The
hard-fail-not-degrade rule (`KvSpillUnsupportedError`, missing-kernel = startup
error) stays — a slow voice session is worse than a clear "this device can't do
256k, use 32k".

---

## Summary of what changed / recommended

- **No catalog edit.** The per-tier `contextLength` values are correct for the
  currently verified bundle set: 0.8B / 2B at `32768`, 4B / 9B at `65536`,
  27B at `131072`, and `27b-256k` at `262144`. The
  compressed-cache default (`kvCacheForContext` → `qjl1_256` + `q4_polar` for
  context > 8k) already applies to every tier. There is no obviously-too-
  conservative number to bump without a RoPE-extended GGUF behind it.
- **Recommended:** (1) a memory-aware *context*
  selector in `recommendation.ts` that raises runtime `dflash.contextSize`
  toward `min(tier.contextLength, baseNativeContext, maxFittingContext)` using
  the `estimateQuantizedKvBytesPerToken` figures; (2) an opt-in
  `preferAccurateKvWhenHeadroom` branch that picks f16/q8_0 KV on hosts with
  abundant VRAM relative to the chosen model+context; (3) consider surfacing
  `27b-256k` on 24 GB GPUs (gated on a passing on-device spill-latency verify).

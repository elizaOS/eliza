# Eliza-1 context-length scaling: how far can we push the window on real machines?

This is the analysis behind the per-tier `contextLength` in `catalog.ts`, the
`dflash.{contextSize,draftContextSize}` knobs in `runtimeFor()`, and the
RAM-budget / spill plumbing in `ram-budget.ts` + `kv-spill.ts`. It answers one
question: **given a phone / 16 GB GPU / 24 GB GPU and an Eliza-1 tier, what is
the largest context window that actually fits, and which optimization should run
when there is spare memory vs when there isn't?**

The short version: on the small tiers (0.6B / 1.7B) the binding limit is the
*base model's positional range* (Qwen3-0.6B / 1.7B ship `max_position_embeddings =
40960`), **not** the KV-cache memory — the compressed cache fits 32k in well
under 1 GiB on any device. On the big tiers (9B / 27B) and the RoPE-extended
27B variants the limit flips: positional range is huge, KV-cache memory is what
gates you, and that is where QJL+PolarQuant compression and (past 64k) KV spill
do the heavy lifting. The catalog's job is to ship the largest *native* window
per tier and then have the runtime pick a context within it that fits the
device. That second half — a memory-aware context selector — is the gap; see
"Wins" below.

---

## 1. The geometry

KV-cache footprint per generated token, summed over all full-attention layers:

```
bytes/token  =  n_layers * n_kv_heads * head_dim * (k_bits + v_bits) / 8
```

Qwen3 dense base shapes (from each base model's `config.json`; the registry's
`model_registry.py` header table is the source of truth):

| Eliza-1 tier      | base model        | layers | kv heads | head_dim | native ctx (`max_position_embeddings`) | GGUF (quant)        |
| ----------------- | ----------------- | -----: | -------: | -------: | -------------------------------------: | ------------------- |
| `eliza-1-0_6b`    | Qwen3.5-0.6B        |     28 |        8 |      128 |                                  40960 | ~0.5 GB (Q3_K_M)    |
| `eliza-1-1_7b`    | Qwen3.5-1.7B        |     28 |        8 |      128 |                                  40960 | ~1.4 GB (Q4-class)  |
| `eliza-1-4b`*     | Qwen3.5-4B          |     36 |        8 |      128 |                                  40960 | ~2.6 GB (Q4_K_M)    |
| `eliza-1-9b`†     | (aspirational)    |      8‡ |        4 |      256 |                          64k → 1M (ext) | ~5.4 GB (Q4_K_M)    |
| `eliza-1-27b`†    | (aspirational)    |     16‡ |        4 |      256 |                         128k → 1M (ext) | ~16.8 GB (Q4_K_M)   |

\* `eliza-1-4b` exists in `model_registry.py` (real, `Qwen/Qwen3.5-4B`) but **not
yet in `catalog.ts`** — flagged below.  
† 9B/27B are `unverified_base=True` placeholders in the registry; the catalog
tiers are aspirational sizes. Numbers below use the registry's hybrid-attention
geometry for them (only 8 / 16 of the layers carry a KV cache; the rest are
linear-attention with constant SSM state — that's why their per-token KV is so
much smaller than a dense model of the same parameter count would be).  
‡ KV-bearing (full-attention) layer count, per the published 3:1 ratio.

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
0.6B / 1.7B/9B/27B — consistent with the per-layer math here once you account for
the realized ratios).

Resulting **bytes/token across the whole KV cache**:

| tier  | f16      | q8_0     | qjl+turbo3 (≤8k fallback) | qjl+polarq4 (**shipping default**) |
| ----- | -------: | -------: | ------------------------: | ---------------------------------: |
| 0.6B  | 114.7 kB | 60.9 kB  |                  ~20.2 kB |                           ~23.7 kB |
| 1.7B  | 114.7 kB | 60.9 kB  |                  ~20.2 kB |                           ~23.7 kB |
| 4B    | 147.5 kB | 78.3 kB  |                  ~25.9 kB |                           ~30.5 kB |
| 9B    |  32.8 kB | 17.4 kB  |                   ~5.8 kB |                            ~6.8 kB |
| 27B   |  65.5 kB | 34.8 kB  |                  ~11.5 kB |                           ~13.6 kB |

(9B/27B are smaller per-token than 0.6B because of the 3:1 linear-attention
ratio — only 8/16 layers cache, and the per-coord cost is identical.)

---

## 2. Max context that fits the KV cache, by device

Budget model: `available_for_KV = device_mem − GGUF_weights − working_set`,
where working_set is the compute/activation/scratch buffers (≈0.6 GB for 0.6B,
0.8 GB for 1.7B, 1.0 GB for 4B, 1.5 GB for 9B, 2.5 GB for 27B). For RAM-budget
hosts (phones, Apple Silicon, CPU) subtract another ~1.5 GB OS reserve
(`DEFAULT_RAM_HEADROOM_RESERVE_MB`); the GPU columns assume dedicated VRAM.
Numbers are "context tokens the cache can hold", rounded.

### Phones — ~4 GB usable / ~8 GB usable

| tier  | layout         |  4 GB | 8 GB  |
| ----- | -------------- | ----: | ----: |
| 0.6B  | f16            |  ~27k |  ~65k |
| 0.6B  | **qjl+polarq4**| ~131k | ~312k |
| 1.7B  | f16            |  ~19k |  ~56k |
| 1.7B  | **qjl+polarq4**|  ~90k | ~271k |
| 4B    | f16            |   —   |  ~32k |
| 4B    | **qjl+polarq4**|  ~14k | ~155k |
| 9B    | qjl+polarq4    |   —   | ~174k |

Takeaway: on a 4 GB phone the **0.6B at the shipping compressed cache fits
~130k tokens** — far past the model's 40960-token positional ceiling. The KV
cache is *not* the limiter at the small end; the base model's RoPE range is.
The 1.7B is comfortable on any modern (≥6 GB) phone. The 4B only fits an 8 GB
phone, and only with the compressed cache. The 9B needs ~8 GB *and* its small
hybrid KV — borderline; reserve it for 12 GB+ phones / 24 GB-RAM tablets, which
is exactly what `minRamGb: 12` does today.

### Gaming / workstation GPUs — 16 GB / 24 GB VRAM

| tier  | layout          | 16 GB | 24 GB |
| ----- | --------------- | ----: | ----: |
| 0.6B  | f16             | ~139k | ~214k |
| 0.6B  | q8_0            | ~263k | ~404k |
| 0.6B  | **qjl+polarq4** | ~674k | ~1.0M |
| 1.7B  | f16             | ~131k | ~206k |
| 1.7B  | **qjl+polarq4** | ~633k | ~995k |
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
  *f16* KV. The compressed cache would let the 9B run >1M tokens on 16 GB if
  the weights supported it (they don't natively yet — see "RoPE extension").
- **0.6B / 1.7B on a 16-24 GB GPU are wildly under-utilizing the device.**
  Weights are 0.5-1.4 GB. After that there are 14-23 GB of unused VRAM. The
  catalog ships them at `32768` context (≈0.6 GiB compressed KV, ≈3.5 GiB at
  f16). Even at f16 KV the 0.6B's 32k window costs 3.5 GiB — fits 16 GB four
  times over. This is the headroom the overhead-aware policy (§5) should spend.

---

## 3. Wins

Ranked by confidence × impact.

### HIGH — ship a memory-aware *context* selector (the real gap)

Today `recommendation.ts` picks a *model* per device, and `pickFittingContextVariant`
picks among *pre-baked context variants of the same model line* (`27b` / `27b-256k`
/ `27b-1m`). There is no path that says "the device has 14 GB of unused VRAM
after loading the 0.6B at its default 32k — bump `contextSize` toward the
model's native ceiling". The numbers above show every device has slack:

- 0.6B / 1.7B: the binding limit is the base model's `max_position_embeddings`
  (40960). The catalog's `32768` is a deliberate safety margin below that. A
  memory-aware selector could safely raise the *runtime* `contextSize` to
  ~40960 on any device — the compressed KV at 40k is still only ~0.93 GiB for
  0.6B, ~0.93 GiB for 1.7B. (Past 40960 needs RoPE extension at build time;
  see below. **Do not** bump `contextLength` in the catalog past the base
  model's positional range without a YaRN/RoPE-scaled GGUF.)
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
for any context > 8192, and every shipping tier is > 8k. So the 0.6B / 1.7B at 32k
already cost ~0.6-0.7 GiB of KV, not 3.5 GiB. Nothing to change — but the doc
above is the justification, and the memory-aware selector (above) must keep
using `qjl+polarq4` as the assumed layout, not f16.

### MEDIUM — add `eliza-1-4b` to `catalog.ts`

`model_registry.py` has a real, buildable `qwen3-4b` → `eliza-1-4b` entry; the
catalog jumps 1.7B → 9B. The 4B fits an 8 GB phone (compressed cache, ~155k
ceiling — though the base model caps at 40960) and is a strong 16 GB-GPU
default (~436k KV ceiling, ~90k even at f16). Once the GGUF is published under
`elizaos/eliza-1-4b`, add the tier with `contextLength: 32768`, `minRamGb: 6`,
`bucket: "small"`. (Out of scope here — no GGUF yet.)

### MEDIUM — `27b-256k` could surface on 24 GB GPUs

Today `minRamGb: 96` means it only appears on 96 GB+ Apple Silicon / servers.
The math says 256k at the compressed cache fits ~22.7 GB on a 24 GB card —
tight, but it works, and it degrades gracefully via KV spill to host RAM past
that. Lower the gate to ~`minRamGb: 24` *only if* the on-device verify pass
confirms the spill path meets the text latency budget; otherwise leave it.

### LOW / informational — no safe catalog `contextLength` bump for the small tiers

It is tempting to read "0.6B fits 800k tokens of KV on 16 GB" and bump
`contextLength` from 32768 to something huge. **Don't.** Qwen3-0.6B / 1.7B have
`max_position_embeddings = 40960`; past that the model produces garbage without
a YaRN/RoPE-scaled GGUF. The catalog's `32768` is correct. The win is the
*runtime* selector raising `contextSize` toward 40960 on roomy devices, not the
catalog default. (If a RoPE-extended small-tier GGUF ever ships — e.g.
`eliza-1-0_6b-128k.gguf` with YaRN 4× — *that* gets a `128k` catalog variant,
matching the `27b` / `27b-256k` / `27b-1m` pattern.)

---

## 4. The mobile story

How the catalog/harness handles low-RAM hosts today:

- `FIRST_RUN_DEFAULT_MODEL_ID = "eliza-1-1_7b"` — the smallest tier that fits
  "the broadest range of hardware (modern phone or laptop)". On first run with
  no preference, that's what loads.
- Hosts that can't fit `eliza-1-1_7b` fall back to `eliza-1-0_6b` via the
  `mobile` ladder in `recommendation.ts`: `TEXT_SMALL: [0_6b, 1_7b]`,
  `TEXT_LARGE: [1_7b, 0_6b]`. `canFit` runs `assessRamFit` against the device's
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
  class is `disk-nvme`: a 0.6B page is ~5 MB ÷ 1.5 GB/s ≈ 3.4 ms — fine for
  text, fine for voice. Spill is viable on phones; it just rarely *triggers*
  because (a) the small tiers cap at 40960 tokens anyway and (b) the compressed
  cache at 40k is under 1 GiB.

**What's missing on mobile:** the same memory-aware context selector. A 4 GB
phone running the 0.6B at the catalog's static 32k is fine, but a 4 GB phone
running the 0.6B *could* run 40960 (the model's native max) for the same KV
cost it already budgets — there's no reason to leave the last ~8k of the
model's range on the table. And an 8 GB phone could run the 4B (if catalogued)
instead of the 1.7B. The selector should: enumerate tiers fitting the device →
pick the largest → pick `contextSize = min(tier.contextLength,
baseNativeContext, maxFittingContextAtCompressedCache − safetyMargin)`.

---

## 5. The overhead-aware policy: VRAM/RAM budget → config

The user's framing: "optimizations that run when we have extra overhead vs when
we can't." A 24 GB GPU running a 0.6B has ~22 GB of spare VRAM — that slack can
buy a *bigger model*, a *bigger context*, a *more accurate KV cache (f16)*, a
*bigger speculative drafter*, or *more parallel contexts* (continuous batching).
A 4 GB phone has none of that — smallest model, most aggressive KV quant, KV
spill armed. Decision table (after a tier is chosen for the device, working out
what to do with the remaining headroom):

| device / situation                              | model         | KV layout            | context (runtime `contextSize`)            | drafter / spec-decode             | parallelism (`optimizations.parallel`) | spill        |
| ----------------------------------------------- | ------------- | -------------------- | ------------------------------------------ | --------------------------------- | --------------------------------------: | ------------ |
| Phone, ~4 GB usable                             | 0.6B          | qjl+polarq4 (forced) | min(40960, fit) — currently 32k             | drafter on, draftMax 6, ngl=auto  | 4 (or 2 if KV is the squeeze)           | armed (disk-nvme); hard-fail if >1.5 s |
| Phone, ~6-8 GB usable                           | 1.7B (or 4B*) | qjl+polarq4          | min(40960, fit) — 32k native cap            | drafter on                        | 4                                       | armed        |
| Phone/tablet, 12 GB+ RAM                         | 9B            | qjl+polarq4          | up to 65536 (catalog) — fits easily         | 9B-distilled drafter              | 4                                       | rarely needed |
| 16 GB GPU                                        | **9B**        | qjl+polarq4 (or **f16** — 16 GB fits f16 KV at 64k with 8.6 GB to spare → use f16 for accuracy) | 65536; could stretch to 128k on a RoPE-ext variant | drafter on, ngl=max, draftGpuLayers=max | 4-8 | not needed |
| 16 GB GPU, **want long context** on small model | 1.7B          | qjl+polarq4          | up to 40960 (native cap)                    | drafter on                        | 8 (lots of room → continuous batching)  | n/a          |
| 24 GB GPU                                        | **27B**       | qjl+polarq4 (f16 only fits ~77k — keep compressed) | 131072 (catalog); stretch toward ~200k if verify ok | 9B-distilled drafter, ngl=max | 8 | armed past ~200k |
| 24 GB GPU, small model on purpose (latency)     | 0.6B / 1.7B   | **f16** (accuracy — 3.5 GiB at 32k, trivial) | 40960 native cap; or run **multiple parallel sessions** (8× contexts × ~0.9 GiB compressed each) | **bigger drafter** (use the 1.7B as drafter for the 0.6B if vocab matches) | 8 | n/a |
| 48 GB+ Apple Silicon (unified)                  | 27B           | qjl+polarq4          | 131072 → 262144 (`27b-256k` if RAM ≥ 96 GB) | 9B drafter                        | 8                                       | unified-mem spill cheap |
| 96 GB+ / GH200                                  | 27B-256k / 27B-1m | qjl+polarq4 / TCQ trellis (`turbo3_tcq` for the K-cache at 1M) | 262144 / 1048576                | 9B drafter, mlock on                    | 8                                       | host RAM at 1M |

The levers, in priority order, when there's spare memory:

1. **Bigger model first.** A 9B at 16 GB beats a 1.7B at 16 GB for quality;
   pick the largest tier that fits with margin. (This is what the ladders do.)
2. **Then bigger context.** Raise runtime `contextSize` toward
   `min(tier.contextLength, baseNativeContext, maxFittingContext)`. Cheap with
   the compressed cache.
3. **Then more accurate KV** (f16 / q8_0) — only worth it when there's enough
   slack to hold f16 *and* the chosen context, which on consumer cards means
   the 0.6B / 1.7B/9B tiers, not the 27B. `kvCacheForContext` would need a
   `preferAccurateKvWhenHeadroom` branch keyed off probed VRAM.
4. **Then a bigger drafter** (better acceptance rate → faster decode) — e.g.
   the 1.7B distilled drafter in front of the 0.6B target, or the existing 9B
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

- **No catalog edit.** The per-tier `contextLength` values are correct: 0.6B / 1.7B at `32768` sit just below the base models' `max_position_embeddings`
  (40960); 9B at `65536` and 27B at `131072` match their RoPE-extended GGUFs;
  the `27b-256k` / `27b-1m` variants and their `minRamGb` gates are right. The
  compressed-cache default (`kvCacheForContext` → `qjl1_256` + `q4_polar` for
  context > 8k) already applies to every tier. There is no obviously-too-
  conservative number to bump without a RoPE-extended GGUF behind it.
- **Recommended (follow-up work, not done here):** (1) a memory-aware *context*
  selector in `recommendation.ts` that raises runtime `dflash.contextSize`
  toward `min(tier.contextLength, baseNativeContext, maxFittingContext)` using
  the `estimateQuantizedKvBytesPerToken` figures; (2) add `eliza-1-4b` to the
  catalog once `elizaos/eliza-1-4b` ships a GGUF; (3) an opt-in
  `preferAccurateKvWhenHeadroom` branch that picks f16/q8_0 KV on hosts with
  abundant VRAM relative to the chosen model+context; (4) consider surfacing
  `27b-256k` on 24 GB GPUs (gated on a passing on-device spill-latency verify).

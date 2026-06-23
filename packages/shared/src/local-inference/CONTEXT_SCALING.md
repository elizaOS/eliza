# Eliza-1 context-length scaling: how far can we push the window on real machines?

> 2026-05-15 audit note: the small-tier 32k recommendation in this memo is
> superseded by the current staging contract. The audited 2B GGUF declares
> `gemma4.context_length = 262144`; release validation still blocks artifacts
> published under misleading `32k`/`64k` text paths, while the catalog/platform
> plan use a 128k release floor for the active 2B/4B/9B/27B/27B-256k tiers
> (see `ELIZA_1_TIER_IDS` in `catalog.ts`) unless a distinct
> verified long-context catalog tier is introduced.

This is the analysis behind the per-tier `contextLength` in `catalog.ts`, the
`mtp.{contextSize,draftContextSize}` knobs in `runtimeFor()`, and the
RAM-budget / spill plumbing in `ram-budget.ts` + `kv-spill.ts`. It answers one
question: **given a phone / 16 GB GPU / 24 GB GPU and an Eliza-1 tier, what is
the largest context window that actually fits, and which optimization should run
when there is spare memory vs when there isn't?**

The short version: on the small tiers (2B / 4B) the binding limit is the
*base model's positional range* (Gemma 4 E2B / E4B ship `max_position_embeddings =
262144`), and the KV-cache memory — the stock q8_0 cache fits 32k in well
under 1 GiB on any device. On the big tiers (9B / 27B) the limit flips:
positional range is huge, KV-cache memory is what
gates you, and that is where the stock q8_0 cache and (past 64k) KV spill
do the heavy lifting. The catalog's job is to ship the largest *native* window
per tier and then have the runtime pick a context within it that fits the
device. That second half — a memory-aware context selector — now lives in
`context-fit.ts` (`computeRuntimeContextFit`), wired through `active-model.ts`;
see "Wins" below.

---

## 1. The geometry

KV-cache footprint per generated token, summed over all full-attention layers:

```
bytes/token  =  n_layers * n_kv_heads * head_dim * (k_bits + v_bits) / 8
```

Gemma 4 base shapes (from each base model's `config.json`; the registry's
`model_registry.py` header table is the source of truth). Gemma 4 is a dense
decoder with alternating SWA/global attention, shared KV, PLE, and MQA
(`n_head_kv = 1`) with dual head dims (512 global / 256 SWA):

| Eliza-1 tier      | base model          | layers | kv heads | head_dim (global/SWA) | native ctx (`max_position_embeddings`) | GGUF (quant)        |
| ----------------- | ------------------- | -----: | -------: | --------------------: | -------------------------------------: | ------------------- |
| `eliza-1-2b`      | google/gemma-4-E2B  |     28 |        1 |             512 / 256 |                                 262144 | ~1.5 GB (Q4-class)  |
| `eliza-1-4b`      | google/gemma-4-E4B  |     36 |        1 |             512 / 256 |                                 262144 | ~2.6 GB (Q4_K_M)    |
| `eliza-1-9b`      | google/gemma-4-12B  |     48 |        1 |             512 / 256 |                            128k target | ~5.4 GB (Q4_K_M)    |
| `eliza-1-27b`     | google/gemma-4-31B  |     62 |        1 |             512 / 256 |                            128k target | ~16.8 GB (Q4_K_M)   |

Gemma 4 uses MQA (a single KV head shared across all query heads) plus
shared-KV across the alternating-attention stack, which is why its per-token KV
is much smaller than a dense multi-head model of the same parameter count.

Bits-per-coordinate per cache layout (what the FFI runtime actually loads —
see `kvCacheForContext()` in `catalog.ts`). Gemma 4's dual head dims (512 global
/ 256 SWA, never 128) mean the head_dim=128 QJL/Polar KV kernels do **not**
apply — every Eliza-1 (Gemma 4) tier runs **stock q8_0 KV**:

| layout  | K bits/coord | V bits/coord | combined B/coord | notes                                  |
| ------- | -----------: | -----------: | ---------------: | -------------------------------------- |
| `f16`   |         16.0 |         16.0 |             4.00 | stock llama.cpp default                |
| `q8_0`  |          8.5 |          8.5 |             2.12 | **the default for every shipping tier** |

q8_0 KV is near-lossless and is the only layout the Gemma 4 dual-head-dim
geometry supports without a head_dim=128 sketch kernel. These are the figures
`model_registry._compute_inference_mem` and
`kv-spill.estimateQuantizedKvBytesPerToken` are both sized against
(`QUANTIZED_KV_BYTES_PER_TOKEN_BY_PARAMS` = 2400 / 9000 / 22000 B/tok for
2B/9B/27B — consistent with the per-layer math here once you account for the
MQA + shared-KV ratios).

Resulting **bytes/token across the whole KV cache**:

| tier  | f16      | q8_0 (**shipping default**) |
| ----- | -------: | --------------------------: |
| 2B    | 114.7 kB |                     60.9 kB |
| 4B    | 147.5 kB |                     78.3 kB |
| 9B    |  32.8 kB |                     17.4 kB |
| 27B   |  65.5 kB |                     34.8 kB |

(9B/27B are smaller per-token than the 2B because Gemma 4's MQA + shared-KV
geometry means fewer cached KV coordinates per layer, and the per-coord cost is
identical.)

---

## 2. Max context that fits the KV cache, by device

Budget model: `available_for_KV = device_mem − GGUF_weights − working_set`,
where working_set is the compute/activation/scratch buffers (≈0.8 GB for 2B,
1.0 GB for 4B, 1.5 GB for 9B, 2.5 GB for 27B). For RAM-budget
hosts (phones, Apple Silicon, CPU) subtract another ~1.5 GB OS reserve
(`DEFAULT_RAM_HEADROOM_RESERVE_MB`); the GPU columns assume dedicated VRAM.
Numbers are "context tokens the cache can hold", rounded.

### Phones — ~4 GB usable / ~8 GB usable

| tier  | layout    |  4 GB | 8 GB  |
| ----- | --------- | ----: | ----: |
| 2B    | f16       |  ~19k |  ~56k |
| 2B    | **q8_0**  |  ~36k | ~106k |
| 4B    | f16       |   —   |  ~32k |
| 4B    | **q8_0**  |   —   |  ~60k |
| 9B    | q8_0      |   —   |  ~70k |

Takeaway: on a 4 GB phone the **2B at the stock q8_0 cache fits ~36k tokens** —
comfortably past a typical chat session, though far short of the model's
262144-token positional ceiling. The 2B is comfortable on any modern (≥6 GB)
phone. The 4B only fits an 8 GB phone. The 9B needs ~8 GB *and* its small
MQA + shared-KV cache — borderline; reserve it for 12 GB+ phones / 24 GB-RAM
tablets, which is exactly what `minRamGb: 12` does today.

### Gaming / workstation GPUs — 16 GB / 24 GB VRAM

| tier  | layout     | 16 GB | 24 GB |
| ----- | ---------- | ----: | ----: |
| 2B    | f16        | ~131k | ~206k |
| 2B    | **q8_0**   | ~248k | ~390k |
| 4B    | f16        |  ~90k | ~149k |
| 4B    | **q8_0**   | ~170k | ~281k |
| 9B    | f16        | ~298k | ~560k |
| 9B    | **q8_0**   | ~561k | ~1.05M |
| 27B   | f16        |   —   |  ~77k |
| 27B   | **q8_0**   |   —   | ~145k |

Takeaways:

- **The 27B does not fit on 16 GB at all** — weights alone are ~16.8 GB. Its
  16 GB story is "use the 9B instead", which the recommender ladder already
  encodes. On 24 GB the 27B fits with ~5 GB to spare → ~145k context at q8_0,
  ~77k at f16. The 27B's `128k` catalog default is the right production call
  until a separately verified long-context 27B artifact exists.
- **The 9B is the sweet spot for 16 GB cards.** Weights ~5.4 GB leaves ~9 GB
  for KV → it fits its `65536` catalog window with ~8.6 GB of headroom even at
  *f16* KV. q8_0 would let the 9B run much longer windows if the weights
  supported them (they don't natively yet — see "RoPE extension").
- **2B / 4B on a 16-24 GB GPU are wildly under-utilizing the device.**
  Weights are 1.4-2.6 GB. After that there are 13-22 GB of unused VRAM. The
  catalog ships them at the 128k release floor, and the stock q8_0 KV path is
  still small enough for modern local hardware. This is the headroom the
  overhead-aware policy (§5) should spend.

---

## 3. Wins

Ranked by confidence × impact.

### RESOLVED — live memory-aware *context* selector

`recommendation.ts` picks a *model* per device, and
`pickFittingContextVariant` picks among *pre-baked context variants of the same
model line* when such variants exist. The live load path now also sizes the
runtime `contextSize` for the chosen tier in
`plugins/plugin-local-inference/src/services/context-fit.ts`, wired through
`active-model.ts`. It computes the largest 4k-stepped q8_0 KV window that fits
the current host budget after the text GGUF footprint and a runtime working set,
then clamps to the bundle/catalog native ceiling. Explicit per-load overrides
still win, and the mobile ceiling still applies after the dynamic choice.

The numbers above show why this matters:

- 2B / 4B: the binding limit is the base model's `max_position_embeddings`
  (262144). The catalog's `131072` is a deliberate release floor below that. A
  memory-aware selector could safely raise the *runtime* `contextSize` to
  262144 on roomy devices when the GGUF metadata and verification evidence
  agree. **Do not** bump `contextLength` in the catalog past the base model's
  positional range without a YaRN/RoPE-scaled GGUF.
- 9B: catalog `131072`. Native range extends to 128k+ for the verified
  variant. On 16 GB the q8_0 KV at 128k is small; the deciding factor is
  weight residency and backend support.
- 27B: catalog `131072` on 24 GB uses ~4.6 GiB q8_0 KV. There's room for
  longer contexts, but those must remain runtime stretch experiments until a
  separately verified long-context 27B artifact passes latency and spill tests.

Implementation now matches the sketch: after admission, compute
`maxFittingContext = floor((usableMb − weightMb − workingSetMb) / kvBytesPerToken)`
using the same `estimateQuantizedKvBytesPerToken` figure `kv-spill.ts` uses,
clamp to `min(model.contextLength, baseModelNativeContext)`, and pass that as
runtime `contextSize` instead of blindly using the static `contextLength`.

### HIGH — default to stock q8_0 KV (already done, keep it)

`kvCacheForContext()` returns the stock q8_0 layout for every shipping tier,
since Gemma 4's dual head dims (512/256) rule out the head_dim=128 sketch
kernels. So the 2B / 4B at 32k cost ~2 GiB of KV, not 3.5 GiB at f16. Nothing
to change — but the doc above is the justification, and the memory-aware
selector (above) must keep using `q8_0` as the assumed layout, not f16.

### RESOLVED — `eliza-1-4b` is in `catalog.ts`

`model_registry.py` has a real, buildable `gemma4-e4b` → `eliza-1-4b` entry; the
catalog now includes the 4B tier at `elizaos/eliza-1/bundles/4b`. The 4B fits
an 8 GB phone at q8_0 (~60k ceiling) and is a strong 16 GB-GPU default
(~170k KV ceiling, ~90k even at f16).

### LOW / informational — no safe catalog `contextLength` bump for the small tiers

It is tempting to read "2B fits 250k tokens of KV on 16 GB" and bump
`contextLength` beyond the release floor. **Don't.** The current catalog
standardizes the active tiers at 128k; the runtime selector should still lower
`contextSize` on constrained devices rather than letting a roomy desktop change
the release contract by accident.

---

## 4. The mobile story

How the catalog/harness handles low-RAM hosts today:

- `FIRST_RUN_DEFAULT_MODEL_ID = "eliza-1-4b"` — the smallest tier that is good
  enough to ship as the default chat model. On first run with no preference,
  that's what loads.
- `eliza-1-2b` is the smallest/entry tier (the low-memory-phone floor); there is
  no smaller fallback below it. Hosts that can't fit the first-run default fall
  back toward `eliza-1-2b` via the `mobile` ladder in `recommendation.ts`.
  `canFit` runs `assessRamFit` against the device's *total* RAM (mobile shares
  GPU memory with system RAM), with the OS headroom reserve and a download-size
  guardrail (`wontFitRatio 0.8`, `tightRatio 0.65`). `eliza-1-2b` is Gemma 4
  E2B; there is no `0.8B` tier.
- `assessRamFit` → `resolveRamBudget`: for an installed Eliza-1 bundle it reads
  `ramBudgetMb.{min,recommended}` from `eliza-1.manifest.json`; otherwise it
  synthesizes `recommendedMb = minRamGb + (q8_0 KV bytes/token ×
  contextLength)`. So "boots" and "runs a long session comfortably" are
  genuinely different lines, sized off the *q8_0* KV footprint.
- Past 64k context on a device whose RAM can't hold the cache, `kv-spill.ts`
  pages cold KV out to host RAM (`cpu`) or NVMe (`disk`), keeping the hot tail
  resident — but it **hard-fails with `KvSpillUnsupportedError`** if the
  worst-case cold-page restore (one 256-token page over PCIe ≈12 GB/s, or NVMe
  ≈1.5 GB/s) can't meet the latency budget (200 ms voice / 1500 ms text). No
  silent-slow fallback. On phones there is no discrete GPU, so the restore
  class is `disk-nvme`: a 2B page is ~5 MB ÷ 1.5 GB/s ≈ 3.4 ms — fine for
  text, fine for voice. Spill is viable on phones; it just rarely *triggers*
  because the compressed RAM budget rarely forces it below the device's fit at
  the catalog's static 32k.

**Mobile status:** the same memory-aware selector feeds live load args and then
the mobile ceiling clamps the result to the currently safe handset window. A 4
GB phone can therefore get a downscaled 2B window instead of a static 128k load,
while an 8 GB-class phone can still take the larger fitting tier through the
device-tier selector.

---

## 5. The overhead-aware policy: VRAM/RAM budget → config

The user's framing: "optimizations that run when we have extra overhead vs when
we can't." A 24 GB GPU running a 2B has ~22 GB of spare VRAM — that slack can
buy a *bigger model*, a *bigger context*, a *more accurate KV cache (f16)*, a
*bigger speculative drafter*, or *more parallel contexts* (continuous batching).
A 4 GB phone has none of that — smallest model, q8_0 KV, KV
spill armed. Decision table (after a tier is chosen for the device, working out
what to do with the remaining headroom):

| device / situation                              | model         | KV layout            | context (runtime `contextSize`)            | drafter / spec-decode             | parallelism (`optimizations.parallel`) | spill        |
| ----------------------------------------------- | ------------- | -------------------- | ------------------------------------------ | --------------------------------- | --------------------------------------: | ------------ |
| Phone, ~4 GB usable                             | 2B            | q8_0 (forced)        | min(262144, fit) — currently 32k            | drafter on, draftMax 6, ngl=auto  | 4 (or 2 if KV is the squeeze)           | armed (disk-nvme); hard-fail if >1.5 s |
| Phone, ~6-8 GB usable                           | 2B (or 4B*) | q8_0                 | min(262144, fit) — 32k default              | drafter on                        | 4                                       | armed        |
| Phone/tablet, 12 GB+ RAM                         | 9B            | q8_0                 | up to 65536 (catalog) — fits easily         | 9B-distilled drafter              | 4                                       | rarely needed |
| 16 GB GPU                                        | **9B**        | q8_0 (or **f16** — 16 GB fits f16 KV at 64k with 8.6 GB to spare → use f16 for accuracy) | 65536; could stretch to 128k on a RoPE-ext variant | drafter on, ngl=max, draftGpuLayers=max | 4-8 | not needed |
| 16 GB GPU, **want long context** on small model | 2B          | q8_0                 | up to 262144 (native cap)                   | drafter on                        | 8 (lots of room → continuous batching)  | n/a          |
| 24 GB GPU                                        | **27B**       | q8_0 (f16 only fits ~77k — keep q8_0) | 131072 (catalog); stretch toward ~200k if verify ok | 9B-distilled drafter, ngl=max | 8 | armed past ~200k |
| 24 GB GPU, small model on purpose (latency)     | 2B / 4B     | **f16** (accuracy — 3.5 GiB at 32k, trivial) | 262144 native cap; or run **multiple parallel sessions** (8× contexts × ~2 GiB q8_0 each) | **bigger drafter** (use the 4B as drafter for the 2B if vocab matches) | 8 | n/a |
| 48 GB+ Apple Silicon (unified)                  | 27B           | q8_0                 | 131072; stretch only behind verification | 9B drafter                        | 8                                       | unified-mem spill cheap |
| 96 GB+ / GH200                                  | 27B           | q8_0 / TCQ trellis for verified stretch windows | 131072+ validation-gated | 9B drafter, mlock on                    | 8                                       | host RAM headroom |

The levers, in priority order, when there's spare memory:

1. **Bigger model first.** A 9B at 16 GB beats a 2B at 16 GB for quality;
   pick the largest tier that fits with margin. (This is what the ladders do.)
2. **Then bigger context.** Raise runtime `contextSize` toward
   `min(tier.contextLength, baseNativeContext, maxFittingContext)`. Cheap with
   the q8_0 cache.
3. **Then more accurate KV** (f16) — only worth it when there's enough
   slack to hold f16 *and* the chosen context, which on consumer cards means
   the 2B / 4B/9B tiers, not the 27B. `kvCacheForContext` would need a
   `preferAccurateKvWhenHeadroom` branch keyed off probed VRAM.
4. **Then a bigger drafter** (better acceptance rate → faster decode) — e.g.
   the 4B distilled drafter in front of the 2B target, or the existing 9B
   drafter in front of the 27B. Already wired (`runtimeFor` sets
   `draftGpuLayers: "auto"`); only the *choice* of drafter is fixed today.
5. **Then more parallel contexts** — `optimizations.parallel` is already
   `8` for ≥131072-context tiers and `4` otherwise; on a roomy device serving a
   small model it could be 8 regardless, enabling continuous batching for
   multiple concurrent sessions.

When there's *no* slack (phones): smallest model, `q8_0` KV (the Gemma 4 default),
`contextSize` = whatever fits, KV spill armed but expected to
rarely fire, `parallel` dropped to 2 if the KV cache is the squeeze. The
hard-fail-not-degrade rule (`KvSpillUnsupportedError`, missing-kernel = startup
error) stays — a slow voice session is worse than a clear "this device can't do
256k, use 32k".

---

## Summary of what changed / recommended

- **No ad hoc catalog edit.** The per-tier `contextLength` values are correct:
  active text tiers use the 128k release floor; device-specific reduction belongs
  in the runtime selector, not in per-tier manifest drift.
  The stock q8_0 KV default (`kvCacheForContext` → `q8_0`) already applies to
  every tier — Gemma 4's dual head dims (512/256) rule out a head_dim=128 sketch
  kernel. There is no obviously-too-conservative number to bump without
  verification evidence behind it.
- **Resolved:** the memory-aware runtime context selector now raises or lowers
  runtime `contextSize` toward
  `min(tier.contextLength, baseNativeContext, maxFittingContext)` using
  `estimateQuantizedKvBytesPerToken`.
- **Resolved (opt-in):** `preferAccurateKvWhenHeadroom` picks f16 KV when the
  host has the headroom to run it at (at least) the q8_0-selected window — it
  only ever upgrades precision, never trades away context. Gated behind
  `ELIZA_PREFER_ACCURATE_KV_WHEN_HEADROOM`; stock q8_0 remains the default and
  only shipped Gemma KV path. Implemented in `context-fit.ts` +
  `active-model.ts` (`resolveRuntimeContextFit`).
- **Still gated:** only add a named long-context 27B tier after the artifact and
  spill-latency gate pass.

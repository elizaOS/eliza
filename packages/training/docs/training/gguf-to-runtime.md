# From `eliza-1-<tier>.gguf` to a running Eliza `TEXT_LARGE`

This is the handoff between this package (the offline training /
quantization / GGUF pipeline) and the Eliza runtime
(`packages/app-core`, `packages/shared`). It assumes you already have a
freshly produced `eliza-1-<tier>.gguf` (e.g. from
`scripts/optimize_for_eliza1.py`, which also writes a
`gguf/eliza1_manifest.json` next to it).

There are two ways to get the runtime to use that file as the
`TEXT_LARGE` model: **point at a local file** (fast, for testing the
GGUF you just built) or **publish + add a catalog entry** (the shipping
path). Both end with the same machinery — `assignments` → `active-model`
coordinator → the local-inference handler — picking the model up.

---

## A. Point the runtime at a local GGUF file

The runtime's model registry (`packages/app-core/src/services/local-inference/registry.ts`)
tracks two kinds of model:

- `source: "eliza-download"` — files Eliza owns, written under the
  state-dir local-inference root. Must live under that root
  (`isWithinElizaRoot`).
- `source: "external-scan"` — GGUF files discovered on disk from other
  tools (LM Studio, Jan, Ollama, raw HF snapshots). These are read-only
  to Eliza and are **never** auto-assigned to `TEXT_SMALL` / `TEXT_LARGE`
  (see `buildRecommendedAssignments` — only default-eligible Eliza-1
  downloads are auto-recommended).

For testing a just-built GGUF, the simplest path is to drop it into the
Eliza-owned models directory so it shows up as an `eliza-download`:

```
$ELIZA_STATE_DIR/local-inference/models/<id>.gguf
```

(`$ELIZA_STATE_DIR` falls back to `$ELIZA_STATE_DIR`, then `~/.eliza`.
The directory is `elizaModelsDir()` in
`packages/shared/src/local-inference/paths.ts`; the local-inference root
is `<state-dir>/local-inference/`.)

The registry only persists entries it wrote itself, so to register an
ad-hoc local file as `eliza-download` you generally want to go through
the runtime API (`POST /api/local-inference/active` with overrides, or
`POST /api/local-inference/assignments`) rather than hand-editing
`registry.json` — `upsertElizaModel` enforces the under-root invariant
and the JSON shape. If the file instead lives in an LM Studio / Jan /
Ollama / HF cache dir, it will be discovered as `external-scan` and
appear in the Model Hub, but you must then assign it explicitly (it
won't be auto-picked).

A catalog entry is **not required** to load a local file — the catalog
(`MODEL_CATALOG`) only supplies download URLs and default runtime flags
(`runtime.kvCache`, `runtime.dflash`, `runtime.optimizations`). Without a
catalog entry the loader falls back to plain defaults; supply the
fork-only KV cache types (`qjl1_256` / `tbq3_0` / `q4_polar`) via
per-load overrides if you need them and you're on the elizaOS/llama.cpp
fork.

## B. The machinery that picks it up

Once a model is installed (either source), three layers route a
`TEXT_LARGE` request to it:

1. **Assignments** (`services/local-inference/assignments.ts`,
   `$STATE_DIR/local-inference/assignments.json`). A *policy*: "serve
   `TEXT_LARGE` with model id X". Set via `POST /api/local-inference/assignments`
   (read via `GET /api/local-inference/assignments`) or programmatically
   with `setAssignment("TEXT_LARGE", id)`. On boot, if **exactly one**
   default-eligible Eliza-1 model is installed and no assignment file
   exists, `autoAssignAtBoot` fills `TEXT_SMALL` + `TEXT_LARGE`
   automatically (`ensureLocalInferenceHandler` calls this). The
   downloader's success path calls `ensureDefaultAssignment` for the
   same reason.

2. **Active-model coordinator** (`services/local-inference/active-model.ts`,
   `ActiveModelCoordinator`). Owns the actual in-memory swap — Eliza runs
   one inference model at a time, so switching unloads the previous one
   first. `resolveLocalInferenceLoadArgs` merges catalog defaults
   (`runtime.kvCache.{typeK,typeV}`, `contextLength`, `gpuLayers`,
   `flashAttention`, `mmap`/`mlock`, and the `runtime.dflash` block) with
   per-load overrides. `POST /api/local-inference/active` switches the
   active model; `DELETE /api/local-inference/active` unloads;
   `GET /api/local-inference/active` reports state.

3. **Runtime handler + router**
   (`packages/app-core/src/runtime/ensure-local-inference-handler.ts`
   plus `services/local-inference/router-handler.ts`). On boot in
   `local` / `local-only` runtime mode, `ensureLocalInferenceHandler`
   registers a `ModelType.TEXT_SMALL` / `TEXT_LARGE` handler at priority
   `0` (provider `eliza-local-inference`, or `eliza-aosp-llama` /
   `capacitor-llama` / `eliza-device-bridge` depending on the loader),
   then installs the top-priority router (`eliza-router`,
   `Number.MAX_SAFE_INTEGER`). On every `TEXT_LARGE` dispatch the handler
   calls `ensureAssignedModelLoaded("TEXT_LARGE")` — which lazy-loads /
   swaps to the assigned model — then generates. The router consults the
   user's per-slot routing policy (`routing-preferences.ts`: `manual` /
   `cheapest` / `fastest` / `prefer-local` / `round-robin`) to pick
   between local and any cloud providers; `manual` + preferred provider
   `eliza-local-inference` forces local.

Relevant env vars / files (no hardcoded ports here, this is all
state-dir + mode):

- `ELIZA_STATE_DIR` / `ELIZA_STATE_DIR` — root for
  `<state-dir>/local-inference/{models,registry.json,assignments.json,routing.json,downloads}`.
- Runtime mode — local-inference handlers only register when the runtime
  mode is `local` or `local-only` (`shouldRegisterLocalInferenceHandlers`).
- `ELIZA_LOCAL_LLAMA=1` — AOSP-only: dlopen `libllama.so` in-process.
- `ELIZA_DEVICE_BRIDGE_ENABLED=1` — route inference to a paired phone.
- `ELIZA_HF_BASE_URL` — redirect catalog downloads to a self-hosted HF
  mirror (catalog only; doesn't affect local files).
- `ELIZA_LOCAL_SESSION_POOL_SIZE` — desktop in-process KV-slot pool size.

## C. No eval gate / rollback before activation — TODO

There is currently **no eval-gate or automatic-rollback step between
"GGUF produced" and "model active as `TEXT_LARGE`"** in the runtime.
`switchTo` loads whatever id you point it at; if generation quality
regresses you only find out from downstream behavior. The offline side
of this package *does* have eval gates (`scripts/eval_gates.py`, wired
into the benchmark suite — and `packages/training/AGENTS.md` §6 is
explicit: green eval + green kernels, then publish), but nothing
re-runs them or compares against a baseline at the moment the runtime
swaps the active model. **TODO:** add a runtime-side pre-activation
smoke / eval check (and a "revert to previous active model" path) so a
bad fine-tune can't silently become the default. Until then, run the
offline eval gates before publishing and before assigning a new GGUF.

## D. Adding the catalog entry (the shipping path)

When the model is published to `elizaos/eliza-1-<tier>` on HuggingFace
and you want it in the curated catalog (so the downloader and the
recommendation engine surface it), emit the `MODEL_CATALOG` row from the
manifest:

```bash
# Print the entry + where it goes (recommended):
uv run python scripts/emit_eliza1_catalog.py \
    --manifest checkpoints/eliza-1-0_8b/gguf/eliza1_manifest.json

# Or produce a unified diff against the canonical shared catalog:
uv run python scripts/emit_eliza1_catalog.py \
    --manifest checkpoints/eliza-1-0_8b/gguf/eliza1_manifest.json \
    --catalog packages/shared/src/local-inference/catalog.ts \
    --output reports/training/catalog-eliza-1-0_8b.diff
```

The canonical catalog is **`packages/shared/src/local-inference/catalog.ts`**
(`@elizaos/shared/local-inference/catalog`). The
`packages/app-core/src/services/local-inference/catalog.ts` path is a
re-export shim — do not edit it. `emit_eliza1_catalog.py` does not
rewrite the file; it prints a labeled patch fragment and names the file
to apply it to. If you are introducing a **new** tier id (not just
refreshing `ggufFile` / `hfRepo` on an existing tier), you must also add
it to `ELIZA_1_TIER_IDS` in that same file by hand — that's the array
that marks a tier default-eligible (`DEFAULT_ELIGIBLE_MODEL_IDS` is built
from it). Review and apply the fragment as a normal TypeScript edit;
`bun run verify` in the repo root typechecks the result.

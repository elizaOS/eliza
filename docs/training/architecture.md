# Training architecture — what produces what

There are several distinct systems in this repo that all use the words
"training" and `eliza-1`, and several that mount routes under `/api/training/*`.
They are **not** the same thing and do not share storage, schedulers, or
output formats. This doc is the map. If a doc or a route comment disagrees with
this file, this file is the intended source of truth.

## TL;DR

| System | Where | What it actually does | Output | Produces `eliza-1` weights? |
|---|---|---|---|---|
| **Offline `packages/training/` pipeline** | `packages/training/` | Fine-tunes a base Qwen3 causal-LM, applies the Milady inference optimizations (PolarQuant / QJL / TurboQuant / DFlash), converts to GGUF | `elizaos/eliza-1-*` GGUF on HuggingFace + a runtime manifest | **Yes — this is the one.** |
| **Plugin vast.ai GPU training** (`/api/training/vast/*`, plus `/api/training/{jobs,datasets,models}`) | `plugins/app-training/` | Dashboard-driven fine-tune jobs on rented vast.ai GPUs against the same Qwen targets; imports the result to Ollama, benchmarks it | A trained checkpoint / GGUF + a `MODEL_CATALOG`-style entry | Yes — it's the *managed UI* in front of (a slice of) the offline pipeline. |
| **Plugin native prompt optimization** (`/api/training/auto/*`, `/api/training/jobs` with `backend: native`) | `plugins/app-training/` + `packages/app-core` `OptimizedPromptService` | MIPRO / GEPA / bootstrap-fewshot over collected trajectories | Prompt artifacts under `~/.milady/optimized-prompts/<task>/` | **No.** No weights are touched. This optimizes *prompts*, not model parameters. |
| **Cloud Vertex AI Gemini fine-tuning** (`/api/training/vertex/*`, `/api/training/trajectories/export`) | `cloud/apps/api/training/`, `cloud/packages/lib/services/vertex-*` | Submits supervised tuning jobs to Google Vertex AI against hosted `gemini-2.5-flash[-lite]`; tracks jobs; assigns the tuned Gemini to a routing "slot" | A tuned Gemini model id wired into a user/org/global model-preference slot | **No.** Hosted Gemini fine-tunes, unrelated to the local `eliza-1` GGUF family. |

## 1. The offline pipeline — `packages/training/` (this is "eliza-1")

`packages/training/` is the only thing in the repo that actually produces the
`eliza-1` weights that ship with Milady and get downloaded onto phones.

- Entry point: `packages/training/scripts/optimize_for_eliza1.py` (full recipe
  in [`optimization-pipeline.md`](optimization-pipeline.md)).
- Base model: a Qwen3 causal-LM. The **smallest target is `eliza-1-0_6b`,
  derived from `Qwen/Qwen3-0.6B`** (older docs called this `eliza-1-lite-0_6b`
  / `eliza-1-lite-0_6b`; the canonical slug is `eliza-1-0_6b`). Larger tiers
  (`eliza-1-2b`, `eliza-1-9b`, `eliza-1-27b`) are planned, not published.
- It composes the four non-upstream GGML types — `Q4_POLAR` (weights),
  `QJL1_256` (K-cache), `TBQ3_0`/`TBQ4_0` (V-cache) — and the DFlash
  spec-decode CLI surface, all of which require the
  `elizaOS/llama.cpp` v0.4.0-milady fork at runtime.
- Publishes to `elizaos/eliza-1-<tier>` on HuggingFace, then
  `emit_eliza1_catalog.py` wires the new repo into
  `packages/app-core/src/services/local-inference/catalog.ts`.
- It does **not** mount any HTTP routes. It is a CLI / cron pipeline.

The other agents own `packages/training/scripts`, `config`, and `benchmarks`;
this doc only describes how the pipeline relates to the route surfaces.

## 2. Plugin vast.ai GPU training — `/api/training/vast/*` and friends

`plugins/app-training/` is the runtime plugin behind Settings → Training. It
exposes two families of routes:

- **`/api/training/vast/*`** — rent vast.ai GPUs, run a fine-tune job, list
  jobs/checkpoints/models, stand up an inference endpoint. This is the
  *managed cloud* lane for the same Qwen → `eliza-1` GGUF flow, driven from
  the dashboard instead of a shell on a GPU box. Vast.ai is the canonical
  cloud here (Nebius is a deprecated fallback).
- **`/api/training/{jobs,datasets,models,backends,status}`,
  `/api/training/auto/*`** — the backend-agnostic surface. `POST
  /api/training/jobs` takes a `backend` (`native` for prompt optimization,
  `atropos` for the atropos backend, or a GPU backend). `/api/training/auto/*`
  is the auto-training scheduler (thresholds, cooldowns, runs).
- **`/api/training/trajectories/*`** and **`/api/trajectories/*`** — the
  runtime's own trajectory store (the `trajectories` table written on every
  turn) and its JSONL export. *This is the local plugin's trajectory store —
  not Cloud's.* It feeds both native prompt optimization and (after privacy
  review) the offline `packages/training/` pipeline.

`plugins/app-training/` is owned by another agent; do not edit it here.

## 3. Plugin native prompt optimization — `/api/training/auto/*`, `backend: native`

This is the **default training backend** (`--backend native`). It does **not**
fine-tune any model. It runs MIPRO / GEPA / bootstrap-fewshot over the
collected trajectories and writes *prompt artifacts* to
`~/.milady/optimized-prompts/<task>/`, which `OptimizedPromptService`
(in `packages/app-core`) auto-loads at boot. Calling this "training" is a bit
of a misnomer — it is prompt optimization, and it touches zero weights. It
shares the `/api/training/*` namespace with the GPU lane only because both are
job-shaped and both run off trajectory data.

## 4. Cloud Vertex AI Gemini fine-tuning — `cloud/apps/api/training/`

The Eliza Cloud API (Cloudflare Workers + Next.js, in `cloud/`) has its own,
completely separate `/api/training/*` surface:

| Route | Method | Purpose |
|---|---|---|
| `/api/training/trajectories/export` | GET, POST | Export an org's LLM trajectories (the `llm-trajectory` Cloud service, **not** the runtime `trajectories` table) as training JSONL. |
| `/api/training/vertex/tune` | (POST) | Submit a Gemini supervised tuning job to Vertex AI. **Currently 501 on the Workers deployment** — see below. |
| `/api/training/vertex/jobs` | GET | List / sync Vertex tuning jobs (remote Vertex state + the `vertex_tuning_jobs` table). |
| `/api/training/vertex/models` | GET | List tuned-Gemini models, current assignments, and the resolved model-preference set. |
| `/api/training/vertex/assignments` | GET, POST, DELETE | Activate / deactivate a tuned-Gemini model into a tuning *slot* (`should_respond`, `response_handler`, `action_planner`, `planner`, `response`, `media_description`) at `global` / `organization` / `user` scope. |

What this is for: when Eliza Cloud is the managed inference backend, an org can
fine-tune `gemini-2.5-flash` / `gemini-2.5-flash-lite` on its own trajectory
data and route specific runtime decision slots to the tuned model. The tuned
model is a **hosted Gemini**, not a local GGUF. None of this touches the
`eliza-1` weight family.

### Why `vertex/tune` is 501 on Workers

`cloud/packages/lib/services/vertex-tuning.ts#createTuningJob` reads the
training/validation JSONL from local disk (`node:fs/promises#readFile`, via
`uploadToGCS`) and falls back to `gcloud auth print-access-token`
(`node:child_process#execFile`) for credentials. Neither `node:fs` nor
`node:child_process` exists in the Cloudflare Workers runtime, so the route at
`cloud/apps/api/training/vertex/tune/route.ts` returns
`501 { error: "not_yet_migrated", reason: "...node:fs...gcloud auth..." }`
with an `alternatives` block. The submit flow is still available three ways:

1. **Offline:** the `packages/training/` pipeline (for `eliza-1` GGUF weights —
   note this is a *different* output than a hosted Gemini fine-tune).
2. **Node runtime:** the same handler runs unchanged where `node:fs` /
   `gcloud` are available.
3. **Two-step on Workers:** `POST /api/training/trajectories/export` → upload
   the JSONL to GCS yourself → submit the job directly against the Vertex
   `tuningJobs` REST API with a `GOOGLE_ACCESS_TOKEN` → track it via
   `GET /api/training/vertex/jobs?name=<vertexJobName>`.

A future Workers port of `vertex/tune` would have to take the training data
inline (request body) or as an already-uploaded `gs://` URI, require an
explicit `GOOGLE_ACCESS_TOKEN` (no `gcloud` shell-out), and call the Vertex
REST API via `fetch` only. The job-tracking, model-listing, and
slot-assignment routes are already Workers-compatible (`fetch` + Drizzle only).

## Naming hazard summary

- **`eliza-1`** = the local GGUF model family from `packages/training/`. The
  Cloud `eliza-1-*` HF *dataset* names (`elizaos/eliza-1-training`,
  `elizaos/eliza-1-assets`) are training inputs / shared assets, not models.
- **"training" in Cloud** = Vertex Gemini fine-tunes + trajectory export.
- **"training" in the plugin** = either GPU fine-tunes (vast.ai) **or** prompt
  optimization (`native`) **or** the auto-training scheduler — disambiguate by
  the `backend` field / the `/vast/` vs `/auto/` path prefix.
- **The thing that "produces eliza-1"** = the offline `packages/training/`
  Python pipeline, full stop. The vast.ai route family is a managed front-end
  to (part of) it; nothing else does weight training.

See also: [`optimization-pipeline.md`](optimization-pipeline.md) (the offline
recipe) and [`huggingface-todo.md`](huggingface-todo.md) (HF repo hygiene that
needs a write-capable `elizaos` token).

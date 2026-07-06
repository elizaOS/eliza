# Unified evidence harness + develop→main certification pipeline

Design doc for consolidating the repo's test/evidence surfaces into one harness with a
machine-verifiable certification gate. Status: design accepted, issues filed (see epic).
Follows the ongoing-development workflow: discussion → this doc → issues → PRs with evidence.

## Problem

An inventory of the current state (2026-07-05) found:

- **5 screenshot capture loops** (vitest/Playwright e2e, `audit:app`, `test:e2e:record`,
  view-audit crawlers, iOS/Android native capture) writing to **9 evidence silos**
  (`e2e-recordings/`, `packages/app/aesthetic-audit-output/`, `packages/app/device-e2e-output/`,
  `packages/app/ios/build/*`, `packages/app/test-results/`, `reports/*`, …).
- **5 reporter systems** with no shared schema; `scripts/evidence-review/generate.mjs` scans the
  silos after the fact and builds a read-only dashboard — the manifest is a summary, not a
  source of truth.
- **4 duplicate visual-verify implementations** (tracked in #14470).
- Artifacts carry **no provenance** (commit, runner, env, duration), so "is this evidence fresh
  and from this code?" is unanswerable mechanically — which is exactly what a promotion gate needs.
- Heuristics stop at OCR + palette + change-metric (`packages/app/scripts/lib/visual-qa.mjs`).
  No image region diff baselines, no perceptual hashing, no object detection, no accessibility-tree
  artifacts, no VLM-based review, no video keyframe analysis.
- Evidence *review* is human/agent work that CI cannot perform, yet develop→main promotion has no
  mechanism to require that the review happened against the promoted commit.

## Design

### 1. Evidence bundle — the core object

One full harness run produces one bundle: `evidence/runs/<run-id>/` with a `manifest.json`
listing every artifact `{ path, sha256, kind, source, lane, producedBy, createdAt }` and a
`meta.json` with provenance `{ commit, branch, runId, runner: local|vast|ci, startedAt,
finishedAt, envFingerprint, tier }`. Layout:

```
evidence/runs/<run-id>/
  manifest.json  meta.json  certification.json (certifier-only)
  lanes/<lane>/result.json + logs/          # unit/server/client/e2e/scenario/native lanes
  trajectories/                             # scenario-runner jsonl + reports
  visual/<surface>/<slug>/{rest,hover,before,after}.png + analysis.json + qa.json
  video/{elements,features,walkthrough}/<slug>.mp4 + keyframes/
  html-trees/<slug>.yaml                    # Playwright ariaSnapshot per region
```

Existing producers are not rewritten; they are **ingested**. The 9 silos keep producing where
they are; ingestors copy/hardlink into the bundle and record provenance. `evidence-review`
dashboard reads the bundle manifest instead of re-scanning silos.

### 2. `@elizaos/evidence` (new `packages/evidence`)

Single home for: manifest schema + builder, analyzer registry, VLM Q&A client, certify
orchestrator, certification sign/verify. Deliberately outside the hot zones
(`packages/app/scripts/**`, `scripts/evidence-review/**` — ~7 in-flight PRs) so consolidation
(#14470) can migrate onto it incrementally.

### 3. Analyzer registry (tiered: cpu | gpu)

Analyzer = pure `(artifact, ctx) → JSON fragment`, each declaring its tier; every run records
per-analyzer status `ran | skipped-tier | failed` (honest skips, never silent).

- **cpu tier (runs everywhere):** `ocr.tesseract` (existing), `ocr.apple-vision` (macOS, #14447),
  `diff.region` (pixelmatch/odiff + changed-region bboxes vs baseline), `color.corners`
  (4 corners + center via `sharp().extract().stats()`), `color.palette` (existing dominant-k),
  `hash.perceptual` (sharp-phash; Hamming ≤ 5–8 = "same screen"), `brand.rules` (existing),
  `tree.aria` (Playwright `ariaSnapshot` YAML, per-region locators), `video.keyframes`
  (ffmpeg `select='gt(scene,0.3)'` → frames → image analyzers per keyframe).
- **gpu tier:** `ocr.unlimited` — Baidu Unlimited-OCR (real: 3B DeepSeek-OCR-based VLM, MIT;
  GGUF `sahilchachra/Unlimited-OCR-GGUF` Q4_K_M 1.8 GiB + F16 mmproj; llama.cpp ≥ 2026-03-25),
  `detect.objects` (YOLO11n ONNX via onnxruntime-node CUDA; OWL-ViT open-vocab optional),
  `qa.local-vlm` (Qwen3-VL GGUF).

GPU models are served by **one resident `llama-server`** (OpenAI-compatible) plus a job queue;
capture lanes POST work to it — no per-job model reloads, no GPU sharing between containers.

### 4. Agent-invoked VLM screenshot Q&A

`vision-qa` CLI + API: an agent reads `analysis.json`, writes targeted questions
("is the send button clipped?", "is the empty state the designed one or a blank panel?"),
and gets structured answers. One image + N questions per request (image tokens paid once),
JSON-schema structured output, prompt-cached rubric, Message-Batches for nightly sweeps.
Backends: Anthropic vision (primary), OpenAI (secondary), local Qwen3-VL via llama-server
(same OpenAI-compat client, swapped base URL). Answers land in `qa.json` beside the pixels.

### 5. Certification protocol

`bun run evidence:certify --tier cpu|gpu|full` runs: test matrix → capture lanes → ingest →
analyzers → VLM Q&A → verdict rollup → reviewer pass (agent or human walks analysis+qa+artifacts,
writes per-subject verdicts) → sign. `certification.json`:

```
{ schema, bundleSha,            // sha256 of manifest.json
  commit, branch, baseRef,
  verdicts: [{ subject, verdict: pass|fail|waived, evidence: [paths], notes }],
  reviewer: { kind: agent|human, id, model? },
  createdAt, signature }        // Ed25519 over the canonicalized payload
```

Private key held by certifiers (`ELIZA_CERT_SIGNING_KEY` — repo secret for the vast runner,
keychain/env for local certifiers); the public key is committed. The bundle itself is uploaded
as a workflow artifact / kept local; only `certification.json` travels with the PR
(commit on the promotion branch or attached via check-run output).

### 6. develop→main CI gate

New workflow `certification-verify.yml` on PRs targeting `main`: verify signature against the
committed public key, `commit` == PR head (or an ancestor with no source-path diffs since),
all verdicts `pass`, freshness window (≤72 h). CI still runs the full test lanes exactly as
today — only the evidence *review* is delegated to certifiers. CI cannot re-review evidence;
it verifies that a trusted reviewer did, against this code.

### 7. Runners

- **Primary — vast.ai:** `scripts/vast/run-certification.mjs`: search offers
  (`verified=true reliability>0.98`, RTX 4090 class ~$0.31–0.40/hr) → create instance from a
  prebuilt CUDA+bun+playwright+models image → onstart runs `evidence:certify --tier full` and
  pushes bundle+cert to storage → poll (`exited|unknown|offline` + hard timeout) → **destroy**
  in an `always()` cleanup. Driven by a `workflow_dispatch`/nightly GH job with a scoped
  `VAST_API_KEY`; on any vast failure the job posts "local certification required".
- **Fallback — local:** an engineer or local agent pulls the PR, runs the same
  `evidence:certify` command on a beefy box (M-series covers cpu tier + MLX quants of the same
  models; CUDA box for full gpu tier), reviews, signs, pushes `certification.json`.

### 8. Single-machine parallelization

`docker/certification/compose.yml` with profiles: `cpu` = N lane containers (one test lane
each, `cpuset` pinning, shared build-cache volume); `gpu` = one llama-server (+ optional ONNX
detector) and one queue worker. Queue is filesystem/SQLite (no redis dep). GPU work pipelines
behind capture: analyzers stream as images appear instead of a barrier at the end.

## Non-goals

- Rewriting existing capture producers (they are ingested, then consolidated incrementally
  under #14470/#14523-style follow-ups).
- Replacing PR-inline evidence for ordinary develop PRs (`AGENTS.md` unchanged; the bundle
  feeds it).
- A second scheduling/queueing system beyond the minimal GPU job queue.

## Related

Epic #14541; children #14552 (bundle foundation), #14542 (analyzers), #14543 (GPU vision lane),
#14544 (VLM Q&A), #14545 (video lanes), #14546 (certify + signing), #14547 (CI gate),
#14548 (vast.ai), #14549 (parallelization), #14550 (consolidation). Prior art it builds
on: #14413/#14452/#14506 (matrix runner + reviewer), #14433 (`visual-qa.mjs`), #14470 (analyzer
consolidation), #14336/#14494/#14505 (device bundles), #14381/#14444 (HITL walkthroughs),
#13620 (coverage enforcement), #13562/#13631 (umbrella epics), #13386 (merge-queue human QA).

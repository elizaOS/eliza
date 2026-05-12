# QwenWebBench — Integration Notes

**Status:** NOT publicly released. No clone available. This directory is a placeholder pending upstream release.

## What it is (per Qwen team blog posts and model cards)

QwenWebBench is an **internal front-end code-generation benchmark** built by the Qwen team during the development of Qwen3-Coder / Qwen3.6 / Qwen3.6-Plus. It evaluates a model's ability to generate complete front-end artifacts (HTML/CSS/JS/SVG, sometimes Canvas/WebGL) from natural-language prompts.

Reported attributes from the Qwen3.6 / Qwen3.6-Plus blog posts and model cards on Hugging Face:

- **Bilingual** prompts (English / Chinese).
- **7 task categories**: Web Design, Web Apps, Games, SVG, Data Visualization, Animation, 3D.
- **Auto-render + multimodal judge** — generated artifacts are rendered headlessly and a vision-capable judge model scores code correctness AND visual correctness against a reference.
- **Bradley-Terry / Elo rating system** — models are pairwise-compared by the judge and ranked on an Elo scale, *not* a 0–1 accuracy.

## Score range — IMPORTANT

The `1068–1536` range in the user's table is **Elo** (Bradley-Terry rating), not percentage. For context, Qwen3.6 is reported to score ~1397 Elo on QwenWebBench vs. its predecessor at ~978 — a 400+ Elo jump (cited in the Qwen3.6 blog and Hugging Face model card for `Qwen/Qwen3.6-35B-A3B`). The 1068–1536 spread in the user's table is consistent with the spread between mid-tier open-source baselines and frontier closed models on this benchmark.

## Public availability

**No public source release as of 2026-05-12.** Searched:

- `gh search repos QwenWebBench` (org-wide and global) → no results.
- `gh search repos --owner SKYLENAGE-AI` → returns QwenClawBench, QwenClawBench-Leaderboard, SWE-CI, PLawBench, HLE-Verified, Skylenage-LawArena, DeepVision-103K, benchmark-health-index. **No QwenWebBench**.
- Qwen HF org (`huggingface.co/Qwen`, `huggingface.co/datasets/skylenage-ai`) → no QwenWebBench dataset.
- Qwen3-Coder blog post (`qwenlm.github.io/blog/qwen3-coder/`) and Qwen3.6 blog (`qwen.ai/blog?id=qwen3.6`) — both reference QwenWebBench numerically but link no source code or dataset.
- Qwen3-Coder-Next technical report (arxiv:2603.00729) — mentions the benchmark but no code release.

Confidence that **no public repo currently exists**: **High**. The benchmark is referenced in marketing material as "internal," consistent with this. SKYLENAGE-AI's pattern is to open-source benchmarks one at a time (QwenClawBench shipped April 2026, ~3 weeks before this writing); QwenWebBench may follow.

## What to do until upstream releases

1. **Do not synthesize a clone.** Building a "QwenWebBench-equivalent" from blog descriptions would not produce comparable Elo numbers — the BT pool, judge model, and reference renders matter.
2. **Track for release**:
   - Watch `https://github.com/SKYLENAGE-AI` (the org that publishes Qwen team benchmarks).
   - Watch the Qwen HF org `skylenage-ai/*` datasets and `Qwen/*` model cards for a dataset link.
   - Watch `qwenlm.github.io/blog/` for a "QwenWebBench released" post.
3. **Substitute benchmarks for front-end code-gen evaluation in the meantime**:
   - **WebDev Arena / WebBench-CC** (community Elo-style front-end leaderboard).
   - **`visualwebbench/`** already lives in `packages/benchmarks/visualwebbench/` — different scope (visual web understanding, not code-gen) but the closest existing harness for headless-render-and-judge flows.
   - **`bigcode-bench` / `LiveCodeBench`** for pure code-correctness signal on front-end-ish prompts.
   - **Internal Eliza front-end eval** (none in this repo today; see `eliza-adapter/`).

## Integration plan — when (if) it ships

Sketch only; revisit once the runner and dataset format are public.

1. **Clone into this directory** (`qwen-web-bench/`) with `--depth 1`, strip `.git` and `.github`, drop demos > 10 MB.
2. **Runner shape (expected)**: Python script that (a) loads prompts, (b) calls the agent / model, (c) writes the generated artifact to a temp dir, (d) renders headlessly (likely Playwright/Puppeteer), (e) submits code + screenshot to the multimodal judge, (f) aggregates BT pairwise outcomes into Elo.
3. **Adapter target**: most likely **`eliza-adapter`** or a new dedicated adapter — OpenClaw is agentic / tool-using, but QwenWebBench is single-turn front-end code generation, so `openclaw-adapter` is the wrong fit. Use whichever adapter exposes a clean "prompt → code artifact" interface for our local models (Qwen3.6 GGUF, Eliza Cloud-served Qwen, etc.).
4. **Sandbox**: headless Chromium for the render step. Probably needs a Docker image with Playwright preinstalled — `packages/benchmarks/lib/` may already have one.
5. **Scoring**: store raw pairwise outcomes; compute Elo locally (don't try to merge into the upstream leaderboard pool unless they publish it). Report deltas vs. a fixed local baseline.
6. **Registry entry**: `qwen_web_bench` in `packages/benchmarks/registry.py` with `score_range = "elo"`, `baseline_required = True`.

## Confidence summary

| Claim | Confidence |
|---|---|
| QwenWebBench is real and used by Qwen team for model evals | High |
| Score range is Elo (BT), spanning ~1000–1500+ | High |
| Benchmark is bilingual, 7 categories, multimodal judge | High (consistent across blog + model card) |
| No public source repo or dataset as of 2026-05-12 | High |
| Likely future home: `SKYLENAGE-AI` GitHub org | Medium (matches the QwenClawBench pattern) |
| Best adapter target when released: `eliza-adapter` or new | Medium (depends on runner shape) |

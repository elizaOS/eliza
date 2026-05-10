# LifeOpsBench — Plan

## Overview

LifeOpsBench is a multi-turn, tool-use benchmark for life-assistant agents. It
measures whether an assistant can complete real life-management tasks
(calendar, mail, messages, contacts, reminders, finance, travel, health,
sleep, focus) by emitting the correct sequence of tool calls against a
deterministic, hashable world state, and saying the right things to a
simulated user along the way.

The motivation is simple: existing benchmarks evaluate either pure tool-use
(BFCL), retail/airline domains (tau-bench), browser DOM operation
(ClawBench), or open-ended conversation quality (woobench). None of them
evaluate the specific surface a personal life assistant lives on:
heterogeneous tool ecosystems, partial information, multi-turn clarification,
and verifiable end-state correctness.

Inspirations and what we take from each:

- **tau-bench** — `Action(name, kwargs)` shape, persona-driven simulated user, dual-agent live evaluation, pass^k metric.
- **ClawBench** — adapter pattern for swapping the agent under test; full-state scoring rather than DOM scraping.
- **REALM-Bench** — domain partitioning across realistic life surfaces.
- **AgentBoard** — progress-rate as a complement to terminal pass/fail; ladder of partial credit.
- **BFCL (Berkeley Function Call Leaderboard)** — strict tool-name + argument scoring as the unambiguous backbone.

## Architecture

Three swappable backend adapters all evaluated on the same scenarios:

1. **elizaOS agent adapter** — drives the elizaOS runtime via the existing TS bench server (extends `eliza-adapter`).
2. **OpenClaw adapter** — drives an OpenClaw-style browser/desktop agent via the openclaw-adapter package.
3. **NousResearch Hermes-template adapter** — drives any model that speaks the Hermes tool-call template (works with local Hermes, llama-cpp servers, or hosted endpoints).

Plus reference agents for sanity:

- **PerfectAgent** — emits the scenario's ground-truth actions on turn 1. Should score ~1.0.
- **WrongAgent** — emits unrelated actions or refuses. Should score ~0.0.
- **cerebras-direct** — calls the eval/teacher model (gpt-oss-120b on Cerebras) directly with the tool manifest. Used as an upper-bound reference for "what does a strong general model do here?".

State: a `LifeWorld` object owns mutable life-state (calendars, mailboxes,
contacts, reminders, finance ledger, travel itineraries, health log, sleep
log, focus sessions). It exposes:

- `tool_manifest()` — the JSON-Schema tool list the agent sees.
- `apply_action(Action)` — mutates state.
- `state_hash()` — canonical sha256 over the sorted state tree.
- `expected_state_hash(scenario)` — the hash the world should reach if the scenario succeeds.

Modes:

- **STATIC** — the user only speaks once (the scenario instruction). If the agent opens with a clarifying question, a `FirstQuestionFallback` provides a canned answer. Then the agent must finish. Cheap, deterministic, scales to thousands.
- **LIVE** — a dual-agent loop. Persona is simulated by the evaluator model (gpt-oss-120b). After each agent turn, the judge model (Claude Opus, intentionally different from the evaluator) checks satisfaction.

## Build Waves

### Wave 1 — Setup

- 1A: Python scaffold (this package).
- 1B: TS action-manifest exporter — emits the JSON-Schema tool list from registered Eliza actions.
- 1C: LifeWorld fixture generator — deterministic seeded worlds from YAML/JSON fixtures.
- 1D: Mockoon extension — bulk fixture serving for high-volume scenarios.
- 1E: Inference clients — Cerebras (OpenAI-compatible), Anthropic native, Hermes-template via litellm.

### Wave 2 — Build

- 2A: 250 STATIC scenarios with `FirstQuestionFallback` across all 10 domains.
- 2B: 250 LIVE dual-agent scenarios across all 10 domains.
- 2C: Eliza adapter (extends existing `eliza-adapter`).
- 2D: OpenClaw adapter via `openclaw-adapter`.
- 2E: Hermes-template adapter.
- 2F: Reference agents (PerfectAgent + WrongAgent + cerebras-direct).
- 2G: Scoring + metrics (state-hash, output-substring, pass^k, progress-rate, per-domain breakdown).

### Wave 3 — Cleanup

- 3A: Adapter-conformance test suite — every backend runs the same 10-scenario subset and produces comparable telemetry.
- 3B: Cost + latency budget enforcement (already wired into the runner via `--max-cost-usd`).
- 3C: CI integration — nightly run on the smoke set; manual trigger for the full set.
- 3D: Privacy filter integration — every fixture and trajectory passed through `app-training/src/core/privacy-filter.ts`.
- 3E: Docs (README, scenario authoring guide, adapter authoring guide).

### Wave 4 — Action Surface Review

- 4A: Audit all Eliza actions for typed parameters; flag untyped or stringly-typed kwargs.
- 4B: LLM-friendliness review of action descriptions — short, declarative, example-bearing.
- 4C: Gap analysis — for each LifeOpsBench scenario, is the action it needs in the registry?
- 4D: Standardize capability tags / contexts / surfaces across actions.

## Scoring Methodology

Each scenario produces a score in `[0, 1]`:

- 50% **state_hash_match**: did the world reach the expected hash?
- 50% **output_substring_matches**: fraction of `required_outputs` that appear in any assistant turn.

Errors, timeouts, and cost-cap aborts force 0. Aggregate metrics:

- **pass@1** = fraction of `(scenario, seed)` pairs scoring exactly 1.0.
- **pass@k** = mean of the unbiased Chen-2021 estimator across scenarios at k = `seeds`.
- **mean_score_per_domain** = mean per-scenario score grouped by `Domain`.
- **progress-rate** (Wave 2G) = fraction of ground-truth actions correctly emitted in order, even if the run didn't terminate cleanly. Surfaces partial competence.

The judge model is intentionally different from the evaluator/user-simulator
model. Using the same model for both biases satisfaction judgments toward
the agent's verbal style. Default split: gpt-oss-120b drives the user;
claude-opus-4-7 judges.

## Cost Discipline

- `--per-scenario-timeout-s` (default 300) — per-run wall-clock cap.
- `--max-cost-usd` (default 10) — cumulative spend cap. Aborted scenarios surface as `terminated_reason="cost_exceeded"` rather than silently truncating the run.
- `--seeds` (default 1) — pass^k requires multiple seeds; the cost cap covers all seeds together.
- `--concurrency` — async semaphore; default 4. Backend rate limits often dominate.

## Open Questions

- **OpenClaw adapter accessibility** — is `openclaw-adapter` exposed as a callable Python package, or do we need to shell out? Affects how we wire `agents/openclaw.py`.
- **Hermes endpoint choice** — local llama.cpp server vs vLLM vs hosted (NousResearch API)? Different tool-call templates resolve at the client layer.
- **Scenario authoring scale** — 500 scenarios is realistic only with a templated authoring pipeline. Wave 2A/2B may need a YAML schema + generator rather than 500 hand-written Python files.

## Differences from Existing Benchmarks

- **vs woobench** — woobench evaluates conversation quality and revenue conversion via a branching response tree. LifeOpsBench evaluates tool-use correctness via state-hash on a deterministic world. There is no persona "score node" walk; correctness is verifiable from state alone.
- **vs tau-bench** — tau-bench is retail + airline. LifeOpsBench is the personal life domain (calendar/mail/messages/health/sleep/focus). Same `Action` shape, broader and more heterogeneous tool ecosystem, persona is a real user not a customer service caller.
- **vs ClawBench** — ClawBench scores against browser DOM state. LifeOpsBench scores against a full, hashable application-state DB (no scraping, no flake from rendering). The OpenClaw adapter brings a ClawBench-style agent into LifeOpsBench's stricter scoring regime.
- **vs BFCL** — BFCL is single-turn, schema-only function calling. LifeOpsBench is multi-turn, with a persona, with state mutation between turns, and with substring requirements on natural-language output. BFCL's strict scoring is a backbone — LifeOpsBench `compare_actions()` borrows the name+kwargs equality model directly.

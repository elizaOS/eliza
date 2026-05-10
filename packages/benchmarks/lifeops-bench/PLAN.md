# LifeOpsBench — Plan

## Overview

LifeOpsBench is a multi-turn, tool-use benchmark for life-assistant agents. It
measures whether an assistant can complete real life-management tasks
(calendar, mail, messages, contacts, reminders, finance, travel, health,
sleep, focus) by emitting the correct sequence of tool calls against a
deterministic, hashable world state, and saying the right things to a
simulated user along the way.

Existing benchmarks evaluate either pure tool-use (BFCL), retail/airline
domains (tau-bench), browser DOM operation (ClawBench), or open-ended
conversation quality (woobench). None of them target the surface a
personal life assistant lives on: heterogeneous tool ecosystems, partial
information, multi-turn clarification, and verifiable end-state
correctness.

Inspirations:

- **tau-bench** — `Action(name, kwargs)` shape, persona-driven simulated user, dual-agent live evaluation, pass^k metric.
- **ClawBench** — adapter pattern for swapping the agent under test; full-state scoring rather than DOM scraping.
- **REALM-Bench** — domain partitioning across realistic life surfaces; mid-run disruptions.
- **AgentBoard** — progress-rate as a complement to terminal pass/fail.
- **BFCL** — strict tool-name + argument scoring as the unambiguous backbone.

## Architecture

Three swappable backend adapters all evaluated on the same scenarios:

1. **elizaOS adapter** — drives the elizaOS runtime via the existing TS bench server.
2. **OpenClaw adapter** — drives an OpenClaw-style browser/desktop agent. PENDING (the upstream `openclaw-adapter` package is currently unavailable).
3. **NousResearch Hermes-template adapter** — drives any model that speaks the Hermes XML `<tool_call>` template.

Plus reference oracles:

- **PerfectAgent** — emits the scenario's ground-truth actions on turn 1.
- **WrongAgent** — emits unrelated actions or refuses.
- **cerebras-direct** — calls gpt-oss-120b on Cerebras directly with the OpenAI tool-call format.

State: a `LifeWorld` object owns mutable life-state (calendars, mailboxes,
contacts, reminders, finance ledger, travel itineraries, health log, sleep
log, subscriptions, notes). It exposes:

- `tool_manifest()` — the JSON-Schema tool list the agent sees (Wave 4 surfaces real per-action schemas).
- `apply_action(Action)` — mutates state via `runner._execute_action`.
- `state_hash()` — canonical sha256 over the sorted state tree.
- `expected_state_hash(scenario)` — derived by replaying ground-truth on a fresh world.

Modes:

- **STATIC** — the user only speaks once (the scenario instruction). If the agent opens with a clarifying question, a `FirstQuestionFallback` provides a canned answer. Then the agent must finish.
- **LIVE** — a dual-agent loop. Persona is simulated by gpt-oss-120b. After each agent turn, claude-opus-4-7 judges satisfaction. Disruptions can mutate the world mid-run.

## Wave status

### Wave 1 — Setup (completed)

- 1A done — Python scaffold (this package).
- 1B done — TS action-manifest exporter (`manifests/actions.manifest.json`, 91 actions).
- 1C done — `LifeWorld` + deterministic seeded snapshots (medium_seed_2026, tiny_seed_42).
- 1D done — Mockoon fixture serving for high-volume scenarios.
- 1E done — Inference clients (Cerebras, Anthropic, Hermes-template via litellm).

### Wave 2 — Build (mostly completed)

- 2A done — Static scenarios authored via candidate-generator pipeline. **53 static scenarios live** across 10 domains (target 250).
- 2B done — LIVE dual-agent scenarios. **15 LIVE scenarios live** with disruptions (target 250).
- 2C done — Eliza adapter (extends `eliza-adapter`; spawns the TS bench server).
- 2D **pending** — OpenClaw adapter. Blocked on the `openclaw-adapter` package, which is currently 404 in the workspace.
- 2E done — Hermes-template adapter (XML `<tool_call>` plumbing inside `clients/hermes.py`).
- 2F done — PerfectAgent + WrongAgent + cerebras-direct.
- 2G done — Scoring + metrics (state_hash + output_substring + pass^k + per-domain breakdown).
- 2H done — Umbrella-action executor reconciliation (`runner._ACTION_HANDLERS` dispatches both umbrella and fine-grained verbs).

### Wave 3 — Cleanup (in progress)

- 3A done — `tests/test_adapter_conformance.py` proves PerfectAgent=1.0 / WrongAgent=0.0 across every adapter against ≤5 STATIC scenarios per domain.
- 3B done — Cost + latency budget enforcement wired into the runner; cap is shared between `agent` and `eval` cost buckets.
- 3C **pending** — CI integration (nightly smoke + manual full).
- 3D done — Privacy filter integration. `eliza_lifeops_bench/ingest/privacy.py` ports the credential + geo redaction patterns from `plugins/app-training/src/core/privacy-filter.ts`. `load_trajectories_from_disk` runs the filter mandatorily and supports a `strict=True` flag that raises `UnredactedCredentialError` if any credential pattern matched on disk.
- 3E done — Docs (this file, `README.md`, `SCENARIO_AUTHORING.md`, `ADAPTER_AUTHORING.md`); benchmark registered in `packages/benchmarks/registry.py`.

### Wave 4 — Action Surface Review

- 4A done — Audit of all Eliza actions for typed parameters.
- 4B **pending** — LLM-friendliness review of action descriptions.
- 4C **pending** — Gap analysis. Some scenarios reference action names that aren't in the manifest (e.g. the legacy fine-grained `PAYMENTS` / `APP_BLOCK` / `WEBSITE_BLOCK` / `SUBSCRIPTIONS_AUDIT` / `SUBSCRIPTIONS_CANCEL` umbrellas). The pre-existing `test_every_action_name_exists_in_manifest` failure is the tracker for this.
- 4D **pending** — Standardize capability tags / contexts / surfaces across actions.

## Roadmap: scaling 53 → 250 static scenarios

The candidate-generator pipeline at
`eliza_lifeops_bench/scenarios/_authoring/` is the target scale path:

1. **Generate** — `python3 -m eliza_lifeops_bench.scenarios._authoring.generate_candidates --domain calendar --n 20` calls Cerebras gpt-oss-120b with the `spec.md` prompt + ≤5 in-context examples + the manifest + the snapshot summary, then writes a candidates JSON for human review.
2. **Validate** — `validate.py` runs deterministic checks: every action name exists in the manifest; every kwarg key is in the action's `parameters.properties`; every entity id resolves in the snapshot; ISO timestamps are well-formed.
3. **Review** — A human reads the candidates JSON, edits or removes bad entries.
4. **Import** — `python3 -m eliza_lifeops_bench.scenarios._authoring.import_reviewed candidates/<file>.json --domain calendar` re-runs validation and appends the surviving candidates to the per-domain module.

Per-domain target distribution (250 static = 25/domain on average):

| Domain    | Current | Target |
| --------- | ------: | -----: |
| calendar  |     11  |     25 |
| mail      |      8  |     25 |
| messages  |      8  |     25 |
| contacts  |      6  |     25 |
| reminders |      6  |     25 |
| finance   |      7  |     25 |
| travel    |      6  |     25 |
| health    |      6  |     25 |
| sleep     |      5  |     25 |
| focus     |      5  |     25 |

The 50% rule from `SCENARIO_AUTHORING.md` (≥50% of static scenarios
must carry a `first_question_fallback`) holds across the corpus today;
keep it green during scale-up.

LIVE scenario scale-up (15 → 250) is more cost-sensitive because each
scenario carries persona simulation + judge calls. Plan: 25/domain
LIVE × $0.05 average = $300 per full LIVE pass. The `--max-cost-usd`
cap is the operational guard.

## Scoring methodology

Each scenario produces a score in `[0, 1]`:

- 50% **state_hash_match**: did the world reach the expected hash?
- 50% **output_substring_matches**: fraction of `required_outputs` that appear in any assistant turn.

Errors, timeouts, and cost-cap aborts force 0. Aggregate metrics:

- **pass@1** = fraction of `(scenario, seed)` pairs scoring exactly 1.0.
- **pass@k** = mean of the unbiased Chen-2021 estimator across scenarios at k = `seeds`.
- **mean_score_per_domain** = mean per-scenario score grouped by `Domain`.
- **progress-rate** (Wave 2G partial) = fraction of ground-truth actions correctly emitted in order, even if the run didn't terminate cleanly.

The judge model is intentionally different from the evaluator/user-simulator
model. Using the same model for both biases satisfaction judgments toward
the agent's verbal style. Default split: gpt-oss-120b drives the user;
claude-opus-4-7 judges.

## Cost discipline

- `--per-scenario-timeout-s` (default 300) — per-run wall-clock cap.
- `--max-cost-usd` (default 10) — cumulative spend cap. Aborted scenarios surface as `terminated_reason="cost_exceeded"` rather than silently truncating the run.
- `--seeds` (default 1) — pass^k requires multiple seeds; the cost cap covers all seeds together.
- `--concurrency` — async semaphore; default 4. Backend rate limits often dominate.
- `BenchmarkResult.{agent_cost_usd, eval_cost_usd}` split the headline so operators can answer "how much was the executor vs. the judge / simulated user?".

## Open questions

- **OpenClaw adapter accessibility (Wave 2D, still open).** The `openclaw-adapter` Python package is currently 404 in the workspace. Two paths: (1) shell out to a CLI; (2) wait for the upstream Python publish. Affects how `agents/openclaw.py` is wired.
- **Hermes endpoint choice (open).** Local llama.cpp vs vLLM vs hosted (NousResearch API). Different tool-call template variants resolve at the `HermesClient` layer.
- **Scenario authoring scale (open, in progress).** 250+250 is realistic only with the candidate-generator pipeline. Current scaffold is in place (`scenarios/_authoring/`); needs operator runs to actually fill the corpus.
- **Action manifest gaps (Wave 4C).** Several existing scenarios reference umbrella action names (`PAYMENTS`, `APP_BLOCK`, `WEBSITE_BLOCK`, `SUBSCRIPTIONS_AUDIT`, `SUBSCRIPTIONS_CANCEL`) that the runner's executor handles but the manifest dump doesn't currently advertise. Either re-export the manifest with these umbrellas included, or replace the scenarios with the specialized action names (`MONEY_DASHBOARD`, `BLOCK_BLOCK`, `MONEY_SUBSCRIPTION_CANCEL`, etc.).

## Differences from existing benchmarks

- **vs woobench** — woobench evaluates conversation quality and revenue conversion via a branching response tree. LifeOpsBench evaluates tool-use correctness via state-hash on a deterministic world. There is no persona "score node" walk; correctness is verifiable from state alone.
- **vs tau-bench** — tau-bench is retail + airline. LifeOpsBench is the personal life domain (calendar/mail/messages/health/sleep/focus). Same `Action(name, kwargs)` shape; broader and more heterogeneous tool ecosystem; persona is a real user, not a customer service caller.
- **vs ClawBench** — ClawBench scores against browser DOM state. LifeOpsBench scores against a full, hashable application-state DB (no scraping, no flake from rendering). The OpenClaw adapter (Wave 2D) brings a ClawBench-style agent into LifeOpsBench's stricter scoring regime.
- **vs BFCL** — BFCL is single-turn, schema-only function calling. LifeOpsBench is multi-turn, with a persona, with state mutation between turns, and with substring requirements on natural-language output. BFCL's strict scoring is a backbone — LifeOpsBench borrows the name+kwargs equality model directly.

# @elizaos-benchmarks/lib

Shared infrastructure imported by every harness and the orchestrator in the LifeOpsBench suite. It is not a runnable benchmark itself.

Two parallel layers exist here — TypeScript (published as `@elizaos-benchmarks/lib`) and Python (importable as `lib`) — because the harnesses are polyglot.

## TypeScript layer (`src/`)

| File | What it does |
|---|---|
| `index.ts` | Public package entry; re-exports everything below |
| `metrics-schema.ts` | Zod schemas for `TurnMetrics`, `RunMetrics`, `Report`, `Delta` — the single source of truth for `report.json` / `delta.json` artifacts written by all three harnesses |
| `model-tiers.ts` | `DEFAULT_TIERS` registry (`small` → local eliza-1 GGUF, `mid` → 2B GGUF, `large` → Cerebras gpt-oss-120b, `frontier` → Anthropic Opus); `resolveTier()` reads `MODEL_TIER` + override env vars |
| `local-llama-cpp.ts` | Adapter to spawn / probe the mtp llama-cpp fork (`~/.cache/eliza-mtp/eliza-llama-cpp`); `startLocalServer()`, `probeMtpFork()`, `resolveLocalBaseUrl()` |
| `eliza-1-bundle.ts` | Reader for the eliza-1 GGUF bundle directory format; `readElizaOneBundle()` + `bundleIsPreRelease()` used by the aggregator to label non-final runs |
| `retrieval-defaults.ts` | Per-tier `topK` / stage-weight profiles for the action-retrieval / RRF system; consumed by benchmark runners and `action-retrieval.ts` |

## Python layer (`lib/`)

| File | What it does |
|---|---|
| `base_benchmark_client.py` | Abstract base client shared by hermes / openclaw / eliza adapters: retry/backoff, bearer auth, cost computation, per-turn telemetry capture |
| `results_store.py` | SQLite trending store (`~/.eliza/benchmarks/results.db`); `ResultsStore` / `BenchmarkRun` / `ComparisonResult` for the promotion gate and dashboard |
| `pricing.py` | Single source of truth for per-million-token pricing tables (Cerebras, Anthropic) so cross-harness cost figures stay consistent |
| `trajectory_normalizer.py` | Converts Eliza / OpenClaw / Hermes-Atropos native trajectory formats into the canonical `eliza_native_v1` JSONL schema for cross-agent comparison and DSPy training |
| `agent_install.py` | Installs and verifies OpenClaw and Hermes-agent under `$ELIZA_AGENTS_ROOT` (`~/.eliza/agents`) for the tri-agent harness |
| `random_baseline.py` | Seedable random-choice baseline agent (`agent_id=random_v1`); stored in `orchestrator.sqlite` and used as a floor — any real agent scoring within noise of random is flagged FAIL |

## Usage

TypeScript consumers import via the package name:

```ts
import { parseReport, resolveTier } from "@elizaos-benchmarks/lib";
```

Python consumers add `packages/benchmarks` to `PYTHONPATH` and import directly:

```python
from lib import BaseBenchmarkClient, ResultsStore
from lib.pricing import compute_cost_usd
```

The suite-level `AGENTS.md` documents orchestrator invocation and how to run individual harnesses.

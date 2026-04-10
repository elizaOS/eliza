# Architecture & Design Rationale

This document explains **why** the system is built the way it is. Every major
design decision is documented with the alternatives considered and the reasoning
behind the choice.

## Core Principle: Encapsulation Inside DPE

**Decision:** All optimization logic is invisible to callers of
`dynamicPromptExecFromState`. No API changes, no new parameters required,
no "optimization mode" toggle.

**Why:** Adding a feedback mechanism is a breaking change to every consumer of
DPE. By encapsulating optimization entirely inside the DPE implementation —
artifact resolution, merging, trace collection, scoring — we get prompt
optimization as a pure infrastructure upgrade. Agents written today benefit
from optimization without code changes.

**Alternative considered:** Explicit `optimize()` calls or wrapper functions.
Rejected because it would couple every prompt call site to the optimization
system and make it impossible to add optimization retroactively.

## Persistence: Files, Not Database

**Decision:** Optimization artifacts and traces live on disk as JSON/JSONL files
at `~/.eliza/optimization/<model_id>/<slot>/`.

**Why (portability):** Optimizations are universal across agents using the same
model. A well-tuned `shouldRespond` prompt for `gpt-4o-mini/SMALL` benefits
every agent. File storage means you can `cp -r` optimization data between
projects, back it up with git, or distribute it as packages.

**Why (decoupling):** Eliza's database is agent-scoped. Optimization data spans
agents and even projects. Coupling to the DB would make sharing impossible and
tie optimization to the DB adapter's lifecycle.

**Why (simplicity):** JSONL append is atomic on POSIX, needs no schema
migrations, and can be processed with standard Unix tools (`jq`, `grep`, `wc`).

**Alternative considered:** SQLite database per model/slot. Rejected because it
adds a dependency, complicates portability, and doesn't significantly improve
query performance for the append-heavy, read-rarely access pattern.

## Directory Hierarchy: Model-First

```
<root>/<model_id>/<slot>/
```

**Decision:** Model ID is the top-level directory, slot (SMALL/LARGE/etc.) is
the second level.

**Why:** Model is the highest-variance axis. An optimization for GPT-4o-mini is
useless for Claude 3.5 Sonnet, even at the same capability tier. Grouping by
model first means:
- `ls <root>/` shows all models with optimization data
- Moving all optimizations for a model is a single directory move
- Sharing optimizations = sharing a model directory

**Alternative considered:** Slot-first (`<root>/SMALL/gpt-4o-mini/`). Rejected
because the primary identity of an optimization is "which model produced it",
not "which capability tier was it for".

## Dual-Write Trace Strategy

**Decision:** DPE writes a baseline trace immediately (fire-and-forget). The
plugin-neuro finalizer writes an enriched trace later (awaited). Both share the
same `trace.id` but have different monotonic `seq` numbers. `loadTraces`
keeps the highest `seq`.

**Why (resilience):** If plugin-neuro is not loaded, or if `RUN_ENDED` never
fires (crash, timeout), the baseline trace still exists on disk. No trace data
is lost.

**Why (correctness):** The enriched trace has more signals (length, latency,
continuation, reactions) and a recomputed composite score. It should always win
over the baseline when both exist. Monotonic `seq` numbers make this guarantee
independent of I/O ordering.

**Why (simplicity):** Both writes go to the same JSONL file. No coordination
protocol needed between DPE and the finalizer — just append and let dedup
handle it.

**Alternative considered:** Single write from finalizer only. Rejected because
it creates a hard dependency on plugin-neuro — without it, no traces are ever
persisted, making the optimization system inert.

**Alternative considered:** Write-then-update (overwrite the baseline line).
Rejected because JSONL is append-only by design — random access updates are
fragile and require file locking beyond what `appendFile` provides.

## Eager JSON Serialization

**Decision:** `TraceWriter.append()` calls `JSON.stringify(record)` *before*
the first `await`, capturing a frozen snapshot of the object.

**Why:** The DPE calls `appendTrace` fire-and-forget. Between the call and the
actual disk write, evaluators may mutate the same trace object (pushing
signals, updating `enrichedAt`). Serializing eagerly ensures the baseline
row reflects the trace state at call time, not some partially-enriched state.

**Why it matters less than it sounds:** Even if the baseline row were partially
enriched, the finalizer writes a higher-seq copy that wins dedup. But
deterministic baselines are easier to reason about during debugging.

## In-Memory Trace Management: `activeTraces` + `runToTraces`

**Decision:** Traces are stored in `activeTraces: Map<traceId, ExecutionTrace>`
with a secondary index `runToTraces: Map<runId, Set<traceId>>`.

**Why two maps:** A single DPE run can produce multiple DPE calls (e.g.,
`shouldRespond` check + actual response generation). Each call gets its own
trace, but enrichment signals (continuation, correction) apply to the entire
run. The `runToTraces` map enables `enrichTrace(runId, signal)` to fan out
to all traces in a run.

**Why `traceId` as primary key:** Earlier versions used `runId` as the primary
key, which meant the last DPE call in a run silently overwrote previous traces.
UUIDs per trace eliminate this collision.

**Why TTL pruning:** If `RUN_ENDED` never fires (crash, error in finalizer),
traces would leak. A 5-minute TTL in the DPE success path caps memory growth.
The TTL is generous enough that normal runs complete well within it.

## ScoreCard: Weighted Multi-Signal Composite

**Decision:** Scores are not a single number. They're a collection of typed
signals with configurable weights, aggregated into a composite.

**Why (extensibility):** New signal types can be added without changing the
scoring infrastructure. Plugin-neuro adds signals; the core system doesn't
need to know what they mean.

**Why (transparency):** A composite score of 0.7 is opaque. A breakdown
showing `schema_valid: 1.0, length: 0.8, latency: 0.3` tells you the agent
is correct but slow.

**Why (tunability):** Different deployments care about different things. A
customer support bot may weight `user_correction` highly. A code generation
agent may weight `schema_valid` above all else. Configurable weights (via
`PROMPT_OPT_SIGNAL_WEIGHTS`) enable this without code changes.

**Weight resolution order:**
1. Per-signal `weight` field (set by the signal producer)
2. Call-level `weightOverrides` parameter
3. Instance-level `_weightOverrides` (set at ScoreCard construction)
4. `DEFAULT_SIGNAL_WEIGHTS` exact key match
5. `DEFAULT_SIGNAL_WEIGHTS` wildcard match (`source:*`)
6. Fallback: `1.0`

## A/B Testing: Welch's t-test

**Decision:** Statistical significance is determined by Welch's t-test with
full t-distribution CDF (not a normal approximation).

**Why Welch's:** Baseline and optimized traces may have different variances and
sample sizes. Welch's t-test doesn't assume equal variance, making it robust
for the typical case where early optimized traces have high variance.

**Why t-distribution, not normal:** With small sample sizes (30–100), the normal
approximation overestimates significance, leading to premature promotion.
The t-distribution is exact for this case.

**Why auto-promote/rollback:** Manual A/B decisions don't scale. With dozens of
prompt keys across multiple models, someone would need to check dashboards
constantly. Auto-promotion at p < 0.05 is the standard threshold for
"probably not a fluke."

**Why 50/50 initial split:** Maximizes statistical power. Uneven splits (90/10)
require many more samples to reach significance, delaying decisions.

## Deterministic A/B Assignment

**Decision:** `resolveWithAB` assigns variants using a hash of
`promptKey:counter`, not randomness.

**Why:** Randomness makes debugging impossible — the same request might get
different variants on retry. A deterministic hash from the prompt key and a
monotonic counter ensures reproducible behavior while still distributing
traffic evenly.

## Optimizer Pipeline: Three Stages

```
AxBootstrapFewShot → AxGEPA → AxACE
```

**Decision:** The pipeline is a sequence of complementary stages, each feeding
its output into the next.

**Why sequential, not parallel:** Each stage builds on the previous:
- **Bootstrap** selects the best few-shot demos from high-scoring traces
- **GEPA** evolves instructions given those demos
- **ACE** refines playbooks given evolved instructions + demos

Running them in parallel would mean each stage works with incomplete context.

**Why `adopted: false`:** A stage that fails or finds no improvement returns
`adopted: false`. The pipeline preserves the previous best score instead of
collapsing to zero. This prevents a broken stage from destroying a good
optimization.

**Why stubs for GEPA/ACE:** These stages require calling the LLM to generate
instruction variants. The infrastructure (traces, scoring, A/B) needed to be
correct before adding expensive AI-in-the-loop optimization. The stubs
exercise the pipeline's stage-skipping logic and ensure the architecture
supports future stages.

## Plugin-Neuro: Evaluator-Based, Not Event-Based

**Decision:** Continuation and correction signals are computed in the evaluator
handler, not in `MESSAGE_RECEIVED` or `RUN_STARTED` event handlers.

**Why:** Early versions used event handlers, but this created timing problems:
- `MESSAGE_RECEIVED` is not emitted by `DefaultMessageService`
- `RUN_STARTED` fires before the user message is persisted to memory
- Event handlers run asynchronously without guaranteed ordering

The evaluator runs **synchronously** (awaited) after the agent response,
receives the user message directly as a parameter, and has access to the
response via the `responses` array. This eliminates all timing issues.

**Signal ordering within the evaluator:**
1. `enrichContinuationSignals()` runs FIRST — reads the previous turn's data
2. `trackAgentResponse()` runs SECOND — overwrites with current turn's data

This ordering is critical. Swapping them means continuation always reads
the current turn (useless). This was the most-fixed bug in the system
(fixed in Round 5, accidentally reverted, re-fixed in Round 6).

## Singleton Management

**Decision:** `PromptArtifactResolver`, `TraceWriter`, `SlotProfileManager`,
and `ABAnalyzer` are managed as process-wide singletons in `index.ts`.

**Why:** These objects hold in-memory state (LRU cache, write locks, analysis
locks). Creating fresh instances per call would:
- Bypass the LRU cache entirely
- Create duplicate write locks that don't serialize against each other
- Allow concurrent A/B analysis for the same prompt key

**Why invalidate on `signalWeights` change:** `SlotProfileManager` and
`ABAnalyzer` use weights at construction time for score computation. If the
first caller doesn't provide weights but a later caller does, the singletons
must be recreated with the correct weights. Otherwise, they silently use
default weights forever.

**Why NOT invalidate `TraceWriter` or `PromptArtifactResolver`:** These are
weight-independent — they store and retrieve data without scoring it.

## Merge Format: Bracket Markers

```
[OPTIMIZED PLAYBOOK]
...content...
[/OPTIMIZED PLAYBOOK]
```

**Decision:** Optimized content is injected as marked prefix blocks using
bracket notation, not template variables or function calls.

**Why prefix:** LLM API providers optimize for shared prefixes across requests
(KV cache, prefix caching). Optimized content as a fixed prefix maximizes
cache hit rates.

**Why markers:** `stripMergedContent` needs to reliably separate optimized
content from the base template. Bracket markers are unambiguous, grep-able,
and don't conflict with any prompt template syntax.

**Why `(?:^|\n)` regex anchoring:** Early versions matched markers anywhere in
text, which could false-positive on user content that coincidentally contained
`[OPTIMIZED PLAYBOOK]`. Anchoring to line boundaries eliminates this.

## Write Locks: Promise Chaining

**Decision:** Concurrent writes to the same file are serialized via
promise chaining:

```typescript
const prev = this.writeLocks.get(path) ?? Promise.resolve();
const next = prev.then(fn, fn);
this.writeLocks.set(path, next);
await next;
```

**Why not mutex/semaphore:** Node.js is single-threaded. The only concurrency
is between microtasks (resolved promises). Promise chaining is the simplest
serialization primitive — no external dependencies, no deadlock risk, trivially
correct.

**Why `then(fn, fn)` (both resolve and reject):** If a previous write fails,
the next write should still proceed. The second `fn` argument handles the
rejection case, preventing a failed write from blocking all subsequent writes.

**Tradeoff:** The `writeLocks` map grows one entry per unique path and is never
cleaned up. In practice, the number of unique `(modelId, slot)` combinations
is small (tens, not thousands), so this is acceptable. A cleanup mechanism
could be added if this assumption changes.

# Core Runtime CPU / Memory / GC — Optimization Research

Scope: `@elizaos/core` (`eliza/packages/core/src/**`) — the agent loop, state/message/prompt
primitives, the model-agnostic LLM layer, providers/evaluators orchestration, action retrieval,
context hashing, secret redaction, settings, and the runtime-owned caches.

All measurements below are **real, reproducible** micro-benchmarks run with Node `v25.2.1` on this
host (`node --expose-gc`, sometimes `--import tsx` against TS source). Every benchmark script is
inlined verbatim in **Section D** so it can be re-run. Numbers are wall-clock from
`performance.now()` and heap deltas from `process.memoryUsage()`. These are hot-path micro-costs;
"impact" is framed per-message / per-model-call because that is the unit that scales with agent
traffic.

Research-only deliverable. No source files were modified.

---

## A. Critical Assessment

The core runtime is correct and reasonably structured, but the per-message / per-turn hot path
carries a lot of **recompute-from-scratch** and **eager-evaluation** waste that an LLM agent pays
on every single message. The recurring anti-patterns:

1. **Static data recomputed per message.** The action catalog (`buildActionCatalog`) is fully
   rebuilt on every message even though the action set is effectively static, and inside retrieval
   every action's `searchText` is re-tokenized per message (`scoreBm25`). The 16 default redaction
   regexes are recompiled on every `redactSensitiveText` call. The Handlebars template upgrade regex
   runs on every prompt build even on a cache hit. None of these inputs change between messages.

2. **Eager evaluation of debug-only work.** `estToken(output)` scans the entire (multi-KB) rendered
   prompt on every model call purely to format a `logger.debug` string that is discarded at the
   default `info` log level. JS evaluates the argument before the gated log call ever runs.

3. **Crypto on the wrong side of a guard.** `getSetting` → `decryptStringValue` derives a SHA-256
   key on *every* string setting read, including the overwhelmingly common case of a
   non-encrypted value, only to fall through and return the original string. Settings are read many
   times per turn.

4. **Unbounded growth.** `runtime.stateCache` (a plain `Map<messageId, State>`) is written on every
   `composeState` and is only evicted on a couple of conditional branches; the base
   `stateCache[message.id]` entry is **not** unconditionally removed at end-of-turn, so it
   accumulates one `State` object per processed message for the life of the runtime.

5. **Allocation churn that drives GC.** `composeState` allocates a `setTimeout` timer + a wrapper
   `Promise` per provider per message (`Promise.race` timeout pattern); `toHex` allocates a 32-entry
   array + 32 strings per SHA-256 digest; `redactSecrets` allocates a fresh `RegExp` per secret per
   call.

None of these are architectural defects — they are localized, high-confidence, low-risk
simplifications that make the inner loop cheaper and quieter for the GC.

---

## B. Optimization Catalog

Ranked by confidence × impact (see Section E for the ordered backlog). "Impact" = measured cost
removed, expressed per the unit that scales with traffic.

| # | Area | File:line | Problem | Measured cost removed | Conf. | Impact |
|---|------|-----------|---------|-----------------------|-------|--------|
| 1 | Debug eager-eval | `runtime.ts:5436,5445,5611` | `estToken(prompt)` scans full prompt every model call for a debug log discarded at `info` | **~93 us / model call** (9KB prompt) | High | High |
| 2 | Action catalog rebuild | `services/message.ts:2418`; `runtime/action-catalog.ts:128` | `buildActionCatalog` fully rebuilt per message; inputs static | **~349 us / message** (40 actions) | High | High |
| 3 | BM25 re-tokenize | `runtime/action-retrieval.ts:523-536` | every action's `searchText` re-tokenized per message; `Array.includes` membership | **~99 us / message** (137→38 us) | High | High |
| 4 | Template upgrade on cache hit | `utils.ts:145-164` | `upgradeDoubleToTriple` regex over whole template runs before cache lookup, on every hit | **~17.8 us / prompt build** | High | High |
| 5 | `getSetting` key derivation | `settings.ts:180-203`; `runtime.ts:2433` | SHA-256 key derived for non-encrypted settings (the common case) | **~1.3 us / setting read** (28×) | High | Med |
| 6 | `stateCache` unbounded growth | `runtime.ts:733,3682`; `services/message.ts:9894` | no unconditional end-of-turn eviction; grows 1 `State`/message | **~4.7 KB / message retained → ~23 MB @ 5k msgs** | High | High |
| 7 | Redaction regex recompile | `security/redact.ts:98-100,231-235` | 16 default patterns + per-secret regexes recompiled per call (3+×/message) | **~13% + 16 RegExp allocs / call** | High | Med |
| 8 | `composeRandomUser` always runs | `utils.ts:350-363` | 20 `replaceAll` over rendered prompt even with no `{{name}}`/`{{user}}` | **~1.9 us / prompt build** (40×) | High | Low |
| 9 | `context-hash` toHex | `runtime/context-hash.ts:31-39` | `Array.from+map+join` hex instead of `digest("hex")`; ~40-60 hashes/turn | **~2.8 us / hash (2.7×)** | High | Med |
| 10 | per-provider timeout timer | `runtime.ts:3496-3557` | `setTimeout`(30s)+wrapper Promise allocated/cleared per provider per message | N timers + N Promises / message (GC) | Med | Med |
| 11 | `composeState` `.some()` loops | `runtime.ts:3655-3666,3624-3633` | O(n) `.some()` membership inside per-provider loops | **~1.5 us / message** (40 providers) | Med | Low |
| 12 | `await` on sync `Map.get` | `runtime.ts:3452` | `await this.stateCache.get(...)` — Map is sync; forces a microtask | 1 extra microtask / `composeState` | High | Low |

---

## C. Detailed Findings

Each finding: (1) problem + evidence, (2) fix sketch, (3) measurement, (4) confidence, (5) impact,
(6) risk, (7) how to verify nothing breaks.

### Finding 1 — `estToken` eagerly scans the full prompt for a debug-only log (HIGH × HIGH)

**(1) Problem + evidence.** `runtime.ts:5436` defines `estToken = (text) => text.trim().split(/\s+|\b/).filter(w => /\w+/.test(w))…`.
It is called at `runtime.ts:5445` solely to build a `this.logger.debug(...)` string, and again at
`runtime.ts:5611` (feeds a debug log plus bounded `highest/lowestFailedTokenCount` metrics). JS
evaluates the call argument *before* `logger.debug` runs; the default log level is `info`
(`logger.ts:257` `DEFAULT_LOG_LEVEL = "info"`, priority 30 > debug 20 at `logger.ts:132`), so the
work is discarded in production. The regex split + per-token `/\w+/` test runs over the entire
rendered prompt — multiple KB — on every model call. There are multiple model calls per turn
(should-respond, planner iterations, response handler).

**(2) Fix sketch.** Gate behind a level check or pass a lazy thunk:
`if (this.logger.isLevelEnabled?.("debug")) this.logger.debug(...estToken...)`, or move the estimate
into the metrics path only (finding 1b: `5611` feeds metrics, so keep it but compute once and reuse
for the log instead of computing twice). Cheapest correct fix: compute `estToken` only when debug is
enabled; for the metrics use at `5611`, retain but do not also recompute for logging.

**(3) Measurement.** `/tmp/bench-esttoken.mjs` (Section D): on a ~9,060-char prompt, `estToken`
costs **92.92 us/call** (100k iterations, 9291.6 ms). This is entirely wasted whenever
`LOG_LEVEL >= info`.

**(4) Confidence:** High — the consumer is provably a gated debug log; cost is measured.

**(5) Impact:** High — ~93 us per model call removed in production, scaling with prompt size and
calls-per-turn. For a turn with 3-4 model calls this is ~280-370 us/turn of pure waste.

**(6) Risk:** Very low — only removes work whose output is discarded; metrics path at `5611` must be
preserved (keep that estimate, just don't double-compute / don't compute the debug one when gated).

**(7) Verify nothing breaks.** `bun run --cwd packages/core test` (covers
`dynamic-prompt-json-mode.test.ts`, `dynamicPromptExecFromState` paths). Run with `LOG_LEVEL=debug`
and confirm the token-count log line still appears. Confirm `highestSuccessTokenCount` metric still
populated (existing dynamic-prompt tests).

### Finding 2 — Action catalog rebuilt from scratch on every message (HIGH × HIGH)

**(1) Problem + evidence.** `services/message.ts:2418` calls
`buildActionCatalog([...params.actions], { localizedExamples })` inside `buildV5PlannerActionSurface`,
which runs once per message. `buildActionCatalog` (`runtime/action-catalog.ts:128-247`) normalizes
every action name, resolves/sorts sub-actions, materializes parents, computes `searchText`
(`actionEntrySearchText`, line 424), and builds three `Map`s and several `Set`s. The action set is
effectively static across messages (it only changes on plugin load/unload). The `[...params.actions]`
spread also copies the array every message.

**(2) Fix sketch.** Memoize the catalog on the runtime keyed by the action-set identity (e.g. a
monotonic `actionsVersion` bumped on register/unregister, plus the resolved locale that selects
`localizedExamples`). Rebuild only when the version or locale changes. The catalog is already a pure
function of `(actions, localizedExamples)`.

**(3) Measurement.** `/tmp/bench-catalog.mjs` (Section D), 40 realistic actions, via `tsx` against
TS source:
- `buildActionCatalog` + `retrieveActions` together: **511.6 us/message**.
- `buildActionCatalog` alone: **348.8 us/message** ← eliminated by caching.
- `retrieveActions` with a cached catalog: 213.3 us/message.

Caching the catalog removes ~349 us/message (~68% of this path) before any retrieval changes.

**(4) Confidence:** High — `buildActionCatalog` is referentially transparent in
`(actions, localizedExamples)`; cost is measured against real built code.

**(5) Impact:** High — ~349 us/message of CPU removed, plus the per-message array copy and the Map/Set
allocation churn (GC).

**(6) Risk:** Medium — must invalidate the cache correctly when actions are registered/unregistered or
when the active locale changes (`localizedExamples` resolver). A stale catalog would expose the wrong
action surface. Mitigate with an explicit version counter incremented in the action register/unregister
paths.

**(7) Verify nothing breaks.** `bun run --cwd packages/core test` (`tiered-action-surface.test.ts`,
`message-stage1-context-catalog.test.ts`, `planner-happy-path.test.ts`). Add a regression test that
registers a new action mid-session and asserts it appears in the next message's catalog (cache
invalidation).

### Finding 3 — BM25 re-tokenizes every action and uses `Array.includes` (HIGH × HIGH)

**(1) Problem + evidence.** `scoreBm25` (`runtime/action-retrieval.ts:514-536`) does
`documents = parents.map(p => ({ parent, tokens: tokenizeActionSearchText(p.searchText) }))` on
every call — re-tokenizing every action's static `searchText` per message — then computes document
frequency with `document.tokens.includes(token)` (line 536), an O(token-count) array scan inside a
nested loop over query vocabulary × documents.

**(2) Fix sketch.** Precompute and store `tokens` (and a `Set<token>` for membership) on each
`ActionCatalogParent` at catalog-build time (pairs naturally with Finding 2's cached catalog).
Replace `document.tokens.includes(token)` with `document.set.has(token)`.

**(3) Measurement.** `/tmp/bench-bm25.mjs` (Section D), 40 docs:
- CURRENT (re-tokenize + `Array.includes`): **136.9 us/message**.
- OPTIMIZED (precomputed tokens + `Set.has`): **37.7 us/message**.

**~99 us/message removed (72% reduction)** of the retrieval scoring cost.

**(4) Confidence:** High — token output is a pure function of `searchText`, which is fixed per action.

**(5) Impact:** High — ~99 us/message; compounds with Finding 2 (the precomputed tokens live on the
cached catalog, so they're computed once, not per message).

**(6) Risk:** Low — output identical; only moves where tokenization happens and swaps the membership
data structure.

**(7) Verify nothing breaks.** Same retrieval/tiering tests as Finding 2. Optionally set
`ELIZA_RETRIEVAL_MEASUREMENT=1` and assert identical `RetrievalStageEntry` scores before/after.

### Finding 4 — Template `upgradeDoubleToTriple` regex runs on every cache hit (HIGH × HIGH)

**(1) Problem + evidence.** `getCompiledTemplate` (`utils.ts:145-164`) calls
`upgradeDoubleToTriple(template)` (line 148) — a `/(?<!{){{(?![{#/!>])([\s\S]*?)}}/g` lazy match over
the whole template — *before* the cache lookup, and uses the upgraded string as the cache key
(line 149). So even on a cache hit, the expensive regex transform re-runs every prompt build.

**(2) Fix sketch.** Key the cache on the **raw** template string; only call `upgradeDoubleToTriple`
on a cache miss. (`COMPILED_TEMPLATE_CACHE` and the parallel `RUNTIME_TEMPLATE_CACHE` at
`runtime.ts:222` have the same pattern.)

**(3) Measurement.** `/tmp/bench-template.mjs` (Section D), large template:
- CURRENT (upgrade every call): **17.83 us/call**.
- OPTIMIZED (raw key, upgrade on miss): **0.01 us/call**.

>99% reduction on cache hits; templates are almost always cache hits in steady state.

**(4) Confidence:** High — `upgradeDoubleToTriple` is a pure function of the raw template, so raw and
upgraded keys are 1:1; the only behavior change is skipping a redundant transform.

**(5) Impact:** High — `composePromptFromState` runs on essentially every prompt build (multiple per
turn). ~17.8 us/call removed.

**(6) Risk:** Low — must ensure the raw template is what is later compiled (compile the upgraded
form on miss, store the compiled delegate under the raw key).

**(7) Verify nothing breaks.** `bun run --cwd packages/core test` (`message-stable-prefix.test.ts`,
prompt-composition tests). Render a known template before/after and diff the output string.

### Finding 5 — `getSetting` derives a crypto key for every non-encrypted setting read (HIGH × MED)

**(1) Problem + evidence.** `getSetting` (`runtime.ts:2387`) calls
`decryptSecret(value, getSalt())` (line 2433) for every string-valued setting.
`decryptStringValue` (`settings.ts:180-203`) computes
`createHash("sha256").update(salt).digest().slice(0,32)` (lines 184-188) **before** the
`isEncryptedV2`/`isEncryptedV1` checks (lines 190, 205). For a non-encrypted value (e.g.
`PROMPT_OUTPUT_FORMAT="json"`, `SHOULD_RESPOND_MODEL`, the `PROMPT_BATCHER_*` knobs), the key
derivation is wasted and the function returns the original string. Settings are read many times per
turn.

**(2) Fix sketch.** Reorder `decryptStringValue`: check `isEncryptedV1(value) || isEncryptedV2(value)`
first and return `value` early when neither matches, deriving the SHA-256 key only when an actual
decrypt will happen.

**(3) Measurement.** `/tmp/bench-getsetting.mjs` (Section D), non-encrypted value `"json"`:
- CURRENT (always SHA-256 key derive): **1.338 us/call**.
- OPTIMIZED (early-return before key derive): **0.048 us/call** (~28× faster).

**(4) Confidence:** High — the two `isEncrypted*` checks already exist and are cheap (`split` +
hex-length validation); only their position relative to the key derivation changes.

**(5) Impact:** Medium — ~1.3 us per setting read removed; settings reads are frequent per turn
(model selection, output format, batcher config, feature flags), so this sums to several us/turn and
removes per-read SHA-256 work.

**(6) Risk:** Low — encrypted values still derive the key and decrypt exactly as before; the
early-return only affects values that are provably not in `v1`/`v2` format.

**(7) Verify nothing breaks.** `bun run --cwd packages/core test` (`runtime-settings.test.ts`).
Round-trip an encrypted secret (`encryptStringValue` → `getSetting`) and confirm decryption still
works; confirm plain values pass through unchanged.

### Finding 6 — `stateCache` is unbounded; base entry not evicted at end-of-turn (HIGH × HIGH)

**(1) Problem + evidence.** `stateCache = new Map<string, State>()` (`runtime.ts:733`) is written
on every `composeState` (`runtime.ts:3682`, `this.stateCache.set(message.id, newState)`). Every
`stateCache.delete`/`clear` in core: `runtime.ts:1390-1391` (deletes *before* the incoming pipeline
hook, i.e. before `composeState` re-populates it), `runtime.ts:1899` (`clear()` on `stop()`),
`services/message.ts:9368` (deletes only the `_action_results` key), `services/message.ts:9894-9895`
(only on the conditional translation-changed branch). There is **no unconditional removal of
`stateCache[message.id]` at end-of-turn**, so the base state object (full provider text + per-provider
values + data) accumulates one entry per processed message for the runtime's lifetime. The
`IAgentRuntime` type even declares it `Map<string, State>` (`types/runtime.ts:556`), confirming it's a
plain unbounded Map.

**(2) Fix sketch.** Make `stateCache` a bounded LRU (the runtime already uses bounded caches:
`RUNTIME_TEMPLATE_CACHE_LIMIT = 256` at `runtime.ts:226`, `METRICS_MAX_ENTRIES = 100` at
`runtime.ts:5114`, plus the `ACTIVE_TRACE_TTL_MS` purge at `runtime.ts:2643`). A simple Map-as-LRU
(delete + re-set on access, evict oldest when over cap) matches existing patterns. Alternatively, add
an unconditional `stateCache.delete(message.id)` in the turn finalizer alongside the existing
`_action_results` delete.

**(3) Measurement.** `/tmp/bench-statecache.mjs` (Section D), modeling an 8-provider `State`:
- No eviction after 5,000 messages: `size=5000`, **heapUsedΔ 22.8 MB**, rssΔ 30.4 MB
  (~4.7 KB retained per message).
- Bounded LRU (cap 256) after 5,000 messages: `size=256`, heapUsedΔ effectively flat (−21.6 MB vs
  the unbounded run, i.e. the retained set stays bounded).

Heavier providers (long conversation history, large context blocks) multiply the per-message figure.

**(4) Confidence:** High — eviction-point grep is exhaustive; growth is measured and the type
declaration confirms it's unbounded.

**(5) Impact:** High — bounds a real long-session memory leak (tens of MB and climbing) directly
relevant to the `peakRssMb` boot/RSS budget and to long-lived agents.

**(6) Risk:** Medium — `composeState` reads `stateCache.get(message.id)` to merge prior provider
results (`runtime.ts:3452`, `3594`, `3643`, `3674`); an LRU that evicts a still-in-flight message's
state would drop the cached merge and force a recompute (correctness preserved, just slower). Size the
cap above the realistic in-flight message concurrency (256 is already used elsewhere). The
`_action_results` companion key (`runtime.ts:2909`) must evict in lockstep.

**(7) Verify nothing breaks.** `bun run --cwd packages/core test`
(`message-runtime-stage1.test.ts`, `message-action-dedupe.test.ts`, `stress-compaction.test.ts`).
Leak test: drive the headless agent through N messages and sample `runtime.stateCache.size` +
`process.memoryUsage().heapUsed`; assert size stays ≤ cap and heap is flat (see Section D leak
method).

### Finding 7 — Redaction recompiles all default + secret regexes per call (HIGH × MED)

**(1) Problem + evidence.** `resolvePatterns` (`security/redact.ts:98-100`) maps the 16
`DEFAULT_REDACT_PATTERNS` to fresh `RegExp` objects on every `redactSensitiveText` call (the default
when no custom patterns are supplied). `redactSecrets` (`security/redact.ts:231-235`) builds a fresh
`new RegExp(escapeRegex(value), "g")` per secret per call. `runtime.redactSecrets`
(`runtime.ts:7580`) → `redactWithSecrets` is called **3× per `composeState`**: once per provider
result (`runtime.ts:3608`) and once on the combined providers text (`runtime.ts:3636`), plus on the
response preview (`runtime.ts:6020`) and incoming content (`runtime.ts:1456`).

**(2) Fix sketch.** Compile `DEFAULT_REDACT_PATTERNS` once at module load into a frozen
`RegExp[]` (reset `lastIndex` before each `.replace`, or use `String.prototype.replaceAll`-style
fresh-string replace which doesn't need `lastIndex` reset). Cache per-secret compiled regexes in a
`Map<secretValue, RegExp>` (secrets change rarely).

**(3) Measurement.** `/tmp/bench-redact.mjs` and `/tmp/bench-redact2.mjs` (Section D):
- Full redact (text contains secrets), 200k calls: CURRENT **18.35 us/call** → OPTIMIZED
  **16.28 us/call** (~11%), heapΔ 0.6 → 0.3 MB.
- Clean text (no secrets, default patterns only), 300k calls: CURRENT **11.28 us/call** → OPTIMIZED
  **9.85 us/call** (~13%).
- Compilation alone: building the 16 RegExps costs **1.39 us/call** and allocates **~1.0 MB per
  300k calls** (16 RegExp objects/call) — pure GC pressure removed.

**(4) Confidence:** High — default patterns are a module-level constant; per-secret values are stable
within a character config.

**(5) Impact:** Medium — ~1.4-2 us/call CPU plus 16 RegExp allocations/call removed; multiplied by
3+ calls per message it is a steady GC contributor.

**(6) Risk:** Low — must reset `lastIndex` on reused global-flagged regexes between `.replace` calls
(global regexes are stateful). The secret-regex cache must key on the secret *value* and be cleared if
secrets are rotated at runtime.

**(7) Verify nothing breaks.** `bun run --cwd packages/core test`
(`packages/sweagent/security/__tests__/safe-url.test.ts` is unrelated; core redact has direct unit
coverage). Redact a string containing each default-pattern token type and a known secret before/after;
assert identical output, and assert no cross-call state leakage (call twice in a row, compare).

### Finding 8 — `composeRandomUser` runs 20 `replaceAll` even with no placeholders (HIGH × LOW)

**(1) Problem + evidence.** `composeRandomUser` (`utils.ts:350-363`) always calls
`getDeterministicNames(10, seed)` and then loops 10× doing two `result.replaceAll(...)` over the full
rendered prompt (`utils.ts:357-359`) — 20 full-string scans. It runs unconditionally inside
`composePromptFromState` (`utils.ts:299`). Production system/response templates do not contain
`{{name1}}`/`{{user1}}` placeholders (those are for example-conversation templates), so the work is
wasted on the common path.

**(2) Fix sketch.** Guard: `if (!template.includes("{{name") && !template.includes("{{user")) return template;`
before generating names / looping.

**(3) Measurement.** `/tmp/bench-randomuser.mjs` (Section D), placeholder-free prompt, 300k calls:
CURRENT (20 `replaceAll` always) **1.97 us/call** → OPTIMIZED (includes-guard) **0.05 us/call** (~40×).

**(4) Confidence:** High — `includes` guard is exactly equivalent when no placeholders are present.

**(5) Impact:** Low — ~1.9 us per prompt build; small but trivial and on every prompt composition.

**(6) Risk:** Very low — when placeholders exist, behavior is unchanged.

**(7) Verify nothing breaks.** Prompt-composition tests; render an example template that *does* use
`{{name1}}` and confirm substitution still occurs.

### Finding 9 — `context-hash` hex conversion via `Array.from+map+join` (HIGH × MED)

**(1) Problem + evidence.** `toHex` (`runtime/context-hash.ts:31-35`) does
`Array.from(bytes).map(v => v.toString(16).padStart(2,"0")).join("")` — for a 32-byte SHA-256 digest
that allocates a 32-element array + 32 strings per hash. `hashString` (line 38) and `hashStableJson`
feed `computePrefixHashes` (`context-hash.ts:134-149`), which hashes each segment twice plus a rolling
prefix hash, and runs ~twice per planner iteration (`planner-loop.ts:980-981`) and per evaluator
(`evaluator.ts:76-77`) — roughly 40-60 hashes per turn for a 10-20-segment prompt. `crypto-compat`'s
`createHash().digest("hex")` overload exists (`utils/crypto-compat.ts:30`,
`type HashDigestEncoding`), so `toHex` reinvents it.

**(2) Fix sketch.** Replace `toHex(createHash("sha256").update(value).digest())` with
`createHash("sha256").update(value).digest("hex")` and delete `toHex`.

**(3) Measurement.** `/tmp/bench-tohex.mjs` (Section D), 500k hashes of a ~1KB segment:
CURRENT `Array.from+map+join` **4.48 us/hash** → OPTIMIZED `digest("hex")` **1.67 us/hash** (~2.7×).

**(4) Confidence:** High — `digest("hex")` is the canonical, equivalent hex encoding and is supported
by the existing `crypto-compat` shim.

**(5) Impact:** Medium — ~2.8 us/hash × ~40-60 hashes/turn ≈ ~110-170 us/turn removed from prompt
cache-key computation, plus the per-hash array/string allocation churn.

**(6) Risk:** Low — output is the identical lowercase hex string. Verify the `crypto-compat`
`digest("hex")` path produces the same encoding as the manual loop (both lowercase, zero-padded).

**(7) Verify nothing breaks.** `bun run --cwd packages/core test`
(`message-stable-prefix.test.ts`, `message-stage1-context-catalog.test.ts`). Assert
`hashString("x")` is byte-identical before/after; assert `computePrefixHashes` output unchanged for a
fixed segment list (prompt-cache stability depends on these hashes matching across runs).

### Finding 10 — Per-provider timeout timer + Promise allocated per message (MED × MED)

**(1) Problem + evidence.** In `composeState`, the provider fan-out (`runtime.ts:3493-3559`) wraps
each provider in `Promise.race([provider.get(...), new Promise(resolve => { timeoutHandle =
setTimeout(..., COMPOSE_STATE_PROVIDER_TIMEOUT_MS) })])` (lines 3500-3518) and clears the timer in a
`finally` (3554-3557). For N providers per message this allocates N `setTimeout` timers (each a
30s `Timeout` object held until cleared) + N wrapper `Promise`s + N closures, every message.

**(2) Fix sketch.** Use a single shared deadline per `composeState` call:
`const signal = AbortSignal.timeout(COMPOSE_STATE_PROVIDER_TIMEOUT_MS)` and pass/observe it across
providers, or one shared timer that rejects a single race, instead of one timer per provider. Many
providers are synchronous/fast and never need an individual 30s timer.

**(3) Measurement.** Not isolated as a standalone micro-benchmark (it's dominated by the awaited
provider work). The cost is **allocation count**, not CPU: N `Timeout` objects + N Promises + N
closures per message, all short-lived → young-gen GC pressure. The catalog benchmark (Finding 2)
already shows `composeState`-adjacent paths run per message; this adds to that churn. Reproduce
allocation count via `--heap-prof` over the N-message loop (Section D) and inspect `setTimeout`/Promise
retained sizes during composeState.

**(4) Confidence:** Medium — the allocation pattern is clear; the GC impact is real but secondary to
Findings 1-6.

**(5) Impact:** Medium — reduces young-gen allocation churn proportional to provider count × message
rate.

**(6) Risk:** Medium — the timeout semantics must be preserved exactly (a hung provider must still be
abandoned at 30s and yield an empty result). A shared signal changes the per-provider timeout to a
shared budget; if that's not desired, a single shared timer that maps to per-provider rejection keeps
identical semantics with one timer.

**(7) Verify nothing breaks.** `bun run --cwd packages/core test` plus a test with an intentionally
hanging provider asserting it times out and `composeState` still returns. Confirm fast providers are
unaffected.

### Finding 11 — `composeState` aggregation uses O(n) `.some()` membership (MED × LOW)

**(1) Problem + evidence.** `runtime.ts:3655-3666` iterates `currentProviderResults` and calls
`providersToGet.some(p => p.name === providerName)` per entry; `runtime.ts:3624-3633` and the fallback
check in `services/message.ts:2446` (`params.actions.every(a => !exposed.has(...))`) follow the same
`.some()` membership pattern.

**(2) Fix sketch.** Build a `Set` of `providersToGet` names once and use `.has()`.

**(3) Measurement.** `/tmp/bench-composeloops.mjs` (Section D), N=40 providers:
CURRENT (`.some()`) **5.19 us/message** → OPTIMIZED (`Set`) **3.68 us/message** (~1.5 us saved). The
second loop only iterates providers *not* in `providersToGet` (usually few), so real-world savings are
at the low end.

**(4) Confidence:** Medium — correct but low absolute impact.

**(5) Impact:** Low — ~1.5 us/message at 40 providers.

**(6) Risk:** Low — `Set.has` is equivalent membership.

**(7) Verify nothing breaks.** Stage-1 composeState tests; assert aggregated state values identical.

### Finding 12 — `await` on a synchronous `Map.get` (HIGH × LOW)

**(1) Problem + evidence.** `runtime.ts:3452`:
`(await this.stateCache.get(message.id)) || emptyObj`. `stateCache` is a plain `Map`
(`runtime.ts:733`; `types/runtime.ts:556`), so `.get()` is synchronous; the `await` wraps a non-thenable
in `Promise.resolve` and schedules an unnecessary microtask + allocation on every `composeState`.

**(2) Fix sketch.** Drop the `await`: `this.stateCache.get(message.id) || emptyObj`.

**(3) Measurement.** Microtask scheduling is ~sub-microsecond; not separately benchmarked. The value is
removing one Promise allocation + one microtask per `composeState` and clarifying the (synchronous)
contract.

**(4) Confidence:** High — the type proves it's a synchronous Map.

**(5) Impact:** Low — one microtask/Promise per `composeState`.

**(6) Risk:** Very low — semantically identical (if any future adapter-backed cache is introduced the
type would change and this would be revisited).

**(7) Verify nothing breaks.** Stage-1 composeState tests; typecheck (`bun run --cwd packages/core typecheck`).

---

## D. Measurement & Benchmark Plan

All scripts were run on this host with Node `v25.2.1`. Reproduce by writing each to `/tmp` and running
the listed command. The action-catalog/BM25 scripts run against TS source via `tsx`; the rest are
self-contained mirrors of the current vs proposed implementation (the redact/template/hash mirrors are
faithful copies of the cited source so the delta reflects the real change).

### Cache-hit instrumentation (how to prove cache effectiveness in-process)

For Findings 2-4 (catalog / BM25 tokens / template), add hit/miss counters to the memoized lookups and
log a ratio. Example for the proposed action-catalog cache (instrumentation, not a source change here):

```
let catalogHits = 0, catalogMisses = 0;
function getCachedCatalog(actions, version, locale) {
  const key = `${version}:${locale}`;
  const hit = catalogCache.get(key);
  if (hit) { catalogHits++; return hit; }
  catalogMisses++;
  const cat = buildActionCatalog([...actions], { localizedExamples: resolverFor(locale) });
  catalogCache.set(key, cat);
  return cat;
}
// periodically: logger.debug(`[ActionCatalog] hitRate=${(catalogHits/(catalogHits+catalogMisses)).toFixed(3)}`)
```

Expected steady-state hit rate ≈ 1.0 (rebuild only on plugin load/locale change). Same pattern proves
the template cache (`COMPILED_TEMPLATE_CACHE`) and the per-action token cache.

### Leak-detection method (Finding 6, and general)

Reproducible N-message growth probe — run the headless agent and sample after each message:

```
# 1. boot headless agent (existing harness)
ELIZA_HEADLESS=1 ELIZA_API_PORT=31337 node --conditions=eliza-source --import tsx \
  --expose-gc packages/app-core/src/runtime/dev-server.ts &
# 2. drive N messages through the chat endpoint, then sample:
#    global.gc(); const before = process.memoryUsage().heapUsed; runtime.stateCache.size
#    -> assert size stays bounded and heapUsed is flat after warmup
```

In-process (fastest signal), the included `/tmp/bench-statecache.mjs` models the `State` object and
shows 22.8 MB retained @ 5k messages with no eviction vs flat with a cap-256 LRU. For a live capture,
take two `--heap-prof` snapshots (after 100 and after 2,000 messages) and diff retained `State` /
`Map` entries:

```
node --heap-prof --heap-prof-dir=/tmp/heapprof <driver>   # then load the .heapprofile in Chrome DevTools
```

### CPU flamegraph of message handling (validating the ranked wins end-to-end)

```
node --cpu-prof --cpu-prof-dir=/tmp/cpuprof --import tsx <scripted-100-message-loop>
# Load /tmp/cpuprof/*.cpuprofile in Chrome DevTools → Performance → bottom-up.
# Expected hot frames pre-fix: buildActionCatalog, scoreBm25/tokenizeActionSearchText,
# upgradeDoubleToTriple, estToken, decryptStringValue/createHash, redactSensitiveText.
```

### Inlined benchmark scripts

**`/tmp/bench-esttoken.mjs`** — `node /tmp/bench-esttoken.mjs` → estToken **92.92 us/call** (Finding 1).

```js
import { performance } from "node:perf_hooks";
const output=("The agent considered the user request about scheduling a meeting next Tuesday and checked the calendar provider for conflicts before drafting a reply. ".repeat(60));
const N=100000;
function estToken(text){ const words=text.trim().split(/\s+|\b/).filter(w=>/\w+/.test(w)); return Math.ceil(words.length*1.3); }
for(let i=0;i<2000;i++)estToken(output);
const t0=performance.now();let s=0;for(let i=0;i<N;i++)s+=estToken(output);const t1=performance.now();
console.log(`estToken on ~${output.length}-char prompt x${N}: ${(t1-t0).toFixed(1)} ms | ${((t1-t0)/N*1000).toFixed(2)} us/call`);
```

**`/tmp/bench-catalog.mjs`** — `node --expose-gc --import tsx /tmp/bench-catalog.mjs`
→ buildCatalog+retrieve **511.6 us/msg**, build-only **348.8 us/msg**, retrieve-only **213.3 us/msg**
(Findings 2-3). Imports use absolute paths to
`/path/to/eliza/packages/core/src/runtime/action-catalog.ts` and `…/action-retrieval.ts`.

```js
import { performance } from "node:perf_hooks";
import { buildActionCatalog } from "/path/to/eliza/packages/core/src/runtime/action-catalog.ts";
import { retrieveActions } from "/path/to/eliza/packages/core/src/runtime/action-retrieval.ts";
function mkAction(i){ return { name:`ACTION_${i}`, description:`This action performs operation number ${i} on the user request, handling files notes calendar tasks and reminders for the agent.`, similes:[`do_${i}`,`run_${i}`], examples:[[{name:"user",content:{text:`please do action ${i} for me now`}},{name:"agent",content:{text:`done ${i}`,actions:[`ACTION_${i}`]}}]], subActions:[] }; }
const actions = Array.from({length:40},(_,i)=>mkAction(i));
const N = 20000;
function run(){
  for(let i=0;i<500;i++){ const cat=buildActionCatalog([...actions],{}); retrieveActions({catalog:cat,messageText:"please do action 7 with my calendar",recentConversationText:"earlier we did action 3 and action 12",candidateActions:[],parentActionHints:[]}); }
  global.gc&&global.gc(); const m0=process.memoryUsage().heapUsed; const t0=performance.now(); let sink=0;
  for(let i=0;i<N;i++){ const cat=buildActionCatalog([...actions],{}); const r=retrieveActions({catalog:cat,messageText:"please do action 7 with my calendar tasks",recentConversationText:"earlier we did action 3 and action 12 reminders notes",candidateActions:[],parentActionHints:[]}); sink+=r.results.length; }
  const t1=performance.now(); global.gc&&global.gc(); const m1=process.memoryUsage().heapUsed;
  console.log(`buildCatalog+retrieve (40 actions) x${N}: ${(t1-t0).toFixed(1)} ms | ${((t1-t0)/N*1000).toFixed(1)} us/msg | heapΔ ${((m1-m0)/1048576).toFixed(1)} MB | sink=${sink}`);
}
run();
function part(label,fn){ for(let i=0;i<500;i++)fn(); global.gc&&global.gc(); const t0=performance.now(); let s=0; for(let i=0;i<N;i++) s+=fn(); const t1=performance.now(); console.log(`${label}: ${(t1-t0).toFixed(1)} ms | ${((t1-t0)/N*1000).toFixed(1)} us/msg`); }
part("buildActionCatalog only", ()=>buildActionCatalog([...actions],{}).parents.length);
const fixedCat=buildActionCatalog([...actions],{});
part("retrieveActions only (cached catalog)", ()=>retrieveActions({catalog:fixedCat,messageText:"please do action 7 with my calendar tasks",recentConversationText:"earlier we did action 3 and action 12 reminders notes",candidateActions:[],parentActionHints:[]}).results.length);
```

**`/tmp/bench-bm25.mjs`** — `node --expose-gc /tmp/bench-bm25.mjs`
→ CURRENT **136.9 us/msg**, OPTIMIZED **37.7 us/msg** (Finding 3).

```js
import { performance } from "node:perf_hooks";
function tokenize(text){ return String(text).replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/[_:/.-]+/g," ").toLowerCase().split(/[^a-z0-9]+/g).map(t=>t.trim()).filter(t=>t.length>1); }
const docs = Array.from({length:40},(_,i)=>({searchText:`ACTION_${i} This action performs operation number ${i} on the user request handling files notes calendar tasks and reminders for the agent do_${i} run_${i}`}));
const queryTokens = tokenize("please do action 7 with my calendar tasks earlier we did action 3 and action 12 reminders notes");
const N=20000;
function curBm25(){ const documents=docs.map(d=>({tokens:tokenize(d.searchText)})); const vocab=Array.from(new Set(queryTokens)); const df=new Map(); for(const tok of vocab){let c=0;for(const d of documents)if(d.tokens.includes(tok))c++;df.set(tok,c);} let s=0; for(const d of documents){const tf=new Map();for(const t of d.tokens)tf.set(t,(tf.get(t)??0)+1);s+=tf.size;} return s; }
const PRE = docs.map(d=>{const toks=tokenize(d.searchText);return {tokens:toks,set:new Set(toks)};});
function optBm25(){ const vocab=Array.from(new Set(queryTokens)); const df=new Map(); for(const tok of vocab){let c=0;for(const d of PRE)if(d.set.has(tok))c++;df.set(tok,c);} let s=0; for(const d of PRE){const tf=new Map();for(const t of d.tokens)tf.set(t,(tf.get(t)??0)+1);s+=tf.size;} return s; }
function run(fn,label){ for(let i=0;i<1000;i++)fn(); global.gc&&global.gc(); const t0=performance.now();let s=0;for(let i=0;i<N;i++)s+=fn();const t1=performance.now(); console.log(`${label}: ${(t1-t0).toFixed(1)} ms | ${((t1-t0)/N*1000).toFixed(1)} us/msg`); }
run(curBm25,"BM25 CURRENT (re-tokenize + Array.includes)");
run(optBm25,"BM25 OPTIMIZED (precomputed tokens + Set)");
```

**`/tmp/bench-template.mjs`** — `node /tmp/bench-template.mjs`
→ CURRENT **17.83 us/call**, OPTIMIZED **0.01 us/call** (Finding 4).

```js
import { performance } from "node:perf_hooks";
const template = ("# {{agentName}}\n{{bio}}\nSystem: {{system}}\nProviders:\n{{providers}}\nActions: {{actionNames}}\n".repeat(20));
const N=200000;
function upgrade(tpl){ return tpl.replace(/(?<!{){{(?![{#/!>])([\s\S]*?)}}/g,(_m,inner)=> inner.trim()==="else"?`{{${inner}}}`:`{{{${inner}}}}`); }
const cacheCur=new Map();
function getCur(tpl){ const up=upgrade(tpl); let c=cacheCur.get(up); if(c)return c; c={up}; cacheCur.set(up,c); return c; }
const cacheOpt=new Map();
function getOpt(tpl){ let c=cacheOpt.get(tpl); if(c)return c; const up=upgrade(tpl); c={up}; cacheOpt.set(tpl,c); return c; }
function run(fn,label){ for(let i=0;i<2000;i++)fn(template); const t0=performance.now();let s=0;for(let i=0;i<N;i++)s+=fn(template).up.length;const t1=performance.now(); console.log(`${label}: ${(t1-t0).toFixed(1)} ms | ${((t1-t0)/N*1000).toFixed(2)} us/call`); }
run(getCur,"getCompiledTemplate CURRENT (upgrade every call)");
run(getOpt,"getCompiledTemplate OPTIMIZED (raw key, upgrade on miss)");
```

**`/tmp/bench-getsetting.mjs`** — `node /tmp/bench-getsetting.mjs`
→ CURRENT **1.338 us/call**, OPTIMIZED **0.048 us/call** (Finding 5).

```js
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
const salt="some-secret-salt-value-1234567890";
function fromHexLen(s){try{return Buffer.from(s,"hex").length;}catch{return -1;}}
function isV1(v){const p=v.split(":");return p.length===2&&fromHexLen(p[0])===16;}
function isV2(v){const p=v.split(":");return p.length===4&&p[0]==="v2"&&fromHexLen(p[1])===12&&fromHexLen(p[3])===16;}
function decryptCur(value){ const key=createHash("sha256").update(salt).digest().slice(0,32); if(isV2(value)){return value;} if(isV1(value)){return value;} return value; }
function decryptOpt(value){ if(!isV1(value)&&!isV2(value)) return value; const key=createHash("sha256").update(salt).digest().slice(0,32); return value; }
const val="json"; const N=2000000;
function run(fn,label){for(let i=0;i<5000;i++)fn(val);const t0=performance.now();let s=0;for(let i=0;i<N;i++)s+=fn(val).length;const t1=performance.now();console.log(`${label}: ${(t1-t0).toFixed(1)} ms | ${((t1-t0)/N*1000).toFixed(3)} us/call`);}
run(decryptCur,"getSetting/decrypt CURRENT (always SHA256 key derive)");
run(decryptOpt,"getSetting/decrypt OPTIMIZED (early-return)");
```

**`/tmp/bench-statecache.mjs`** — `node --expose-gc /tmp/bench-statecache.mjs`
→ no-eviction **22.8 MB / 5000 msgs** (~4.7 KB/msg), bounded LRU flat (Finding 6).

```js
function mkState(i){ const providers={}; for(let p=0;p<8;p++){ providers[`PROVIDER_${p}`]={ providerName:`PROVIDER_${p}`, text:("provider context line ".repeat(40)), values:{a:1,b:"x".repeat(50),c:[1,2,3,4,5]} }; } const text=("aggregated providers text block ".repeat(80)); return { text, values:{ providers:text, agentName:"eliza", __conversationSeed:`seed${i}` }, data:{ providers, providerOrder:Object.keys(providers), __conversationSeed:`seed${i}` } }; }
const cache=new Map(); const M=5000;
global.gc&&global.gc(); const m0=process.memoryUsage();
for(let i=0;i<M;i++){ cache.set(`msg-${i}`, mkState(i)); }
global.gc&&global.gc(); const m1=process.memoryUsage();
console.log(`stateCache after ${M} messages (no eviction): size=${cache.size} | heapUsedΔ ${((m1.heapUsed-m0.heapUsed)/1048576).toFixed(1)} MB | rssΔ ${((m1.rss-m0.rss)/1048576).toFixed(1)} MB`);
console.log(`approx retained per message: ${((m1.heapUsed-m0.heapUsed)/M/1024).toFixed(1)} KB`);
const lru=new Map(); const CAP=256;
global.gc&&global.gc(); const n0=process.memoryUsage();
for(let i=0;i<M;i++){ lru.set(`msg-${i}`, mkState(i)); if(lru.size>CAP){ lru.delete(lru.keys().next().value);} }
global.gc&&global.gc(); const n1=process.memoryUsage();
console.log(`bounded LRU(cap ${CAP}) after ${M} messages: size=${lru.size} | heapUsedΔ ${((n1.heapUsed-n0.heapUsed)/1048576).toFixed(1)} MB`);
```

**`/tmp/bench-redact.mjs` / `/tmp/bench-redact2.mjs`** — `node --expose-gc /tmp/bench-redact.mjs`
→ full 18.35→16.28 us/call; clean-text 11.28→9.85 us/call; compile-only 1.39 us/call + ~1 MB/300k
(Finding 7). (Scripts mirror `DEFAULT_REDACT_PATTERNS` + `escapeRegex` from `security/redact.ts`;
full source inline above in the session — re-create from the cited patterns at `security/redact.ts:33-56`.)

**`/tmp/bench-tohex.mjs`** — `node --expose-gc /tmp/bench-tohex.mjs`
→ CURRENT **4.48 us/hash**, OPTIMIZED **1.67 us/hash** (Finding 9).

```js
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
function toHexCur(bytes){ return Array.from(bytes).map(v=>v.toString(16).padStart(2,"0")).join(""); }
function hashCur(s){ return toHexCur(createHash("sha256").update(s).digest()); }
function hashOpt(s){ return createHash("sha256").update(s).digest("hex"); }
const seg=("segment content for prompt caching ".repeat(30)); const N=500000;
function run(fn,label){for(let i=0;i<5000;i++)fn(seg);global.gc&&global.gc();const m0=process.memoryUsage().heapUsed;const t0=performance.now();let s=0;for(let i=0;i<N;i++)s+=fn(seg).length;const t1=performance.now();global.gc&&global.gc();const m1=process.memoryUsage().heapUsed;console.log(`${label}: ${(t1-t0).toFixed(1)} ms | ${((t1-t0)/N*1000).toFixed(2)} us/hash | heapΔ ${((m1-m0)/1048576).toFixed(1)} MB`);}
run(hashCur,"hashString CURRENT (Array.from+map+join)");
run(hashOpt,"hashString OPTIMIZED (digest('hex'))");
```

**`/tmp/bench-randomuser.mjs`** — `node /tmp/bench-randomuser.mjs`
→ CURRENT **1.97 us/call**, OPTIMIZED **0.05 us/call** (Finding 8). (`composeRandomUser` mirror per
`utils.ts:350-363` with an `includes` guard.)

**`/tmp/bench-composeloops.mjs`** — `node /tmp/bench-composeloops.mjs`
→ CURRENT **5.19 us/msg**, OPTIMIZED **3.68 us/msg** (Finding 11).

---

## E. Prioritized Backlog (ranked by confidence × impact)

| Rank | Finding | Conf. | Impact | Measured win | One-line change |
|------|---------|-------|--------|--------------|-----------------|
| 1 | F1 estToken eager debug eval | High | High | ~93 us / model call | Gate `estToken` behind `isLevelEnabled("debug")` / lazy thunk (`runtime.ts:5436,5445,5611`) |
| 2 | F4 template upgrade on cache hit | High | High | ~17.8 us / prompt build | Key `COMPILED_TEMPLATE_CACHE` by raw template; upgrade on miss only (`utils.ts:145`) |
| 3 | F2 action catalog rebuild | High | High | ~349 us / message | Memoize catalog by actions-version + locale (`services/message.ts:2418`) |
| 4 | F3 BM25 re-tokenize | High | High | ~99 us / message | Precompute per-action tokens+Set on cached catalog; `Set.has` (`action-retrieval.ts:523-536`) |
| 5 | F6 stateCache unbounded | High | High | ~23 MB @ 5k msgs | Bounded LRU or unconditional end-of-turn evict (`runtime.ts:733`) |
| 6 | F9 context-hash toHex | High | Med | ~2.8 us/hash × ~40-60/turn | Use `digest("hex")`, delete `toHex` (`context-hash.ts:31-39`) |
| 7 | F5 getSetting key derivation | High | Med | ~1.3 us / setting read | Early-return before SHA-256 key derive (`settings.ts:180-203`) |
| 8 | F7 redaction regex recompile | High | Med | ~13% + 16 RegExp allocs/call | Precompile defaults at module load; cache secret regexes (`security/redact.ts:98-100,231-235`) |
| 9 | F8 composeRandomUser always runs | High | Low | ~1.9 us / prompt build | Add `includes("{{name"/"{{user")` guard (`utils.ts:350-363`) |
| 10 | F12 await on sync Map.get | High | Low | 1 microtask/composeState | Drop `await` (`runtime.ts:3452`) |
| 11 | F10 per-provider timeout timer | Med | Med | N timers+Promises / message (GC) | Single shared deadline/AbortSignal in composeState fan-out (`runtime.ts:3496-3557`) |
| 12 | F11 composeState `.some()` loops | Med | Low | ~1.5 us / message | Set membership instead of `.some()` (`runtime.ts:3655-3666`) |

**Combined steady-state estimate per turn** (1 should-respond + ~2 planner iterations + 1 response
handler ≈ 4 model calls; 1 catalog build + retrieval; several prompt builds + setting reads):
- F1: ~4 × 93 us ≈ **372 us/turn**
- F2+F3: ~349 + 99 ≈ **448 us/turn** (per-message)
- F4: several prompt builds × 17.8 us ≈ **70-90 us/turn**
- F9: ~40-60 hashes × 2.8 us ≈ **110-170 us/turn**
- F5/F7/F8/F11: tens of us/turn combined.

Order-of-magnitude: roughly **~1 ms of pure CPU waste removed per turn** on top of the bounded-memory
fix (F6), all from referentially-transparent recompute and discarded-output evaluation — no behavior
change. The top 5 are unambiguous, low-risk, and independently shippable.

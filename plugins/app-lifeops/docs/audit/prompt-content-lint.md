# Default-pack prompt-content lint corpus

**Owner:** W1-D (Wave-1 Agent D — default-pack curation).
**Status:** Wave-1 ships **warnings only**; Wave-3 (W3-B) promotes to CI-fail.

## Why

The runtime cannot semantically prevent a curator from baking PII, host-specific paths, owner-specific clock times, or conditional logic into a `ScheduledTask.promptInstructions` string. The runner driving the spine intentionally ignores `promptInstructions` as a control surface (it's pure content). That makes it an attractive backdoor for "just hardcode it" — exactly what `HARDCODING_AUDIT.md` flags.

This lint pass catches those slips at the CI boundary so the registry-driven invariant is enforced statically.

## Where it runs

- `eliza/plugins/app-lifeops/scripts/lint-default-packs.mjs` — node script invoked by `bun run verify` (via the plugin's `pretest` hook and dedicated `lint:default-packs` script). Reads the source files of `src/default-packs/*.ts` directly so it doesn't depend on a TS runtime.
- The same regex corpus is exposed at runtime via `src/default-packs/lint.ts` (`lintPromptText`, `lintPack`, `lintPacks`) so any code path that registers a pack — including third-party plugin contributions — can opt in.

## Rules

| Rule kind | Pattern | Fix |
|---|---|---|
| `pii_name` | Word-boundary match on a closed list of known PII names: `Jill`, `Marco`, `Sarah`, `Suran`, `Samantha` (from `HARDCODING_AUDIT.md` §3). | Reference owner facts via `contextRequest.includeOwnerFacts.preferredName`. For non-owner contacts, reference entities via `contextRequest.includeEntities.entityIds`. |
| `absolute_path` | `^/`, `~/`, or `[A-Z]:\` followed by a path segment ≥ 2 chars. | Default packs ship across hosts. Use a relative reference, an owner-fact-derived path, or a connector capability check. |
| `hardcoded_iso_time` | Standalone `HH:MM`, `HH:MM:SS`, or full ISO datetimes — but **only** when no owner-fact reference is anywhere in the prompt. References allowed: `morningWindow`, `eveningWindow`, `quietHours`, the literal `HH:MM` placeholder. | Reference `ownerFact.morningWindow` / `eveningWindow` / `quietHours`, or use a trigger anchor (`relative_to_anchor`, `during_window`). |
| `embedded_conditional` | `if user`, `if user's`, `when X = Y`, `when X: Y`, `if owner`, `if the user is`, `if name is`, `when name is`. | Express as a registered gate (`task.shouldFire.gates`) or a `completionCheck` rule, not as content. |

## Adding new patterns

When a new hardcoding leak is observed:

1. Add the pattern to the regex constant in `src/default-packs/lint.ts` (`PII_NAMES`, `ABSOLUTE_PATH_REGEX`, `ISO_TIME_REGEX`, `ISO_DATE_REGEX`, `OWNER_FACT_TIME_PATTERNS`, or `CONDITIONAL_REGEX`).
2. Mirror the change in `scripts/lint-default-packs.mjs` (the script duplicates the regex set so it can run without a TS runtime).
3. Add a test case in `test/default-packs.lint.test.ts`.
4. Document the addition here.

## Wave-3 promotion (W3-B)

- Flip the runner script from default warnings to default failures (`--fail-on-finding` becomes the implicit default).
- Calibrate the false-positive rate against the full corpus of registered packs, including plugin-contributed packs.
- Run a one-time pass over all shipped packs to confirm zero findings before flipping.

## Allowlist policy

There is no allowlist today. If a pack genuinely needs to embed one of the patterns (e.g. a tutorial pack referencing `08:00` as an example time), the curator either rephrases or escalates the concern to W3-B for a per-record `// lint-ignore-line: <rule>` mechanism. Wave-1 explicitly does **not** ship that mechanism.

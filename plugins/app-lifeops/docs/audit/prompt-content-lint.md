# Default-pack prompt-content lint corpus

**Owner (Wave 1):** W1-D — initial corpus + warnings-only runner.
**Owner (Wave 3):** W3-B — corpus expansion + CI-fail promotion.
**Status:** **CI-fail.** Any finding fails `bun run verify` for `@elizaos/app-lifeops`.

## Why

The runtime cannot semantically prevent a curator from baking PII, host-specific paths, owner-specific clock times, conditional logic, hardcoded URLs, or AI-generated leftovers into a `ScheduledTask.promptInstructions` string. The runner driving the spine intentionally ignores `promptInstructions` as a control surface (it's pure content). That makes it an attractive backdoor for "just hardcode it" — exactly what `HARDCODING_AUDIT.md` flags.

This lint pass catches those slips at the CI boundary so the registry-driven invariant is enforced statically.

## Where it runs

- `eliza/plugins/app-lifeops/scripts/lint-default-packs.mjs` — Node script invoked by the plugin's `pretest` hook and by `bun run verify` (via `lint:default-packs`). Reads the source files of `src/default-packs/*.ts` directly so it doesn't depend on a TS runtime.
- `eliza/plugins/app-lifeops/src/default-packs/lint.ts` — runtime entry points (`lintPromptText`, `lintPack`, `lintPacks`, `formatFindings`) re-exported from `default-packs/index.ts`. Any code path that registers a pack — including third-party plugin contributions — can opt in.

The script and the runtime module duplicate the regex corpus on purpose: the script must run without a TS runtime, and the runtime module backs in-process registration. **When a rule changes, both must be updated.**

## Rules

| Rule kind | Pattern | Fix |
|---|---|---|
| `pii_name` | Word-boundary, case-sensitive match on a closed list of known PII proper nouns: `Jill`, `Marco`, `Sarah`, `Suran`, `Samantha` (from `HARDCODING_AUDIT.md` §3). | Reference owner facts via `contextRequest.includeOwnerFacts.preferredName`. For non-owner contacts, reference entities via `contextRequest.includeEntities.entityIds`. |
| `email_pii` | `local@host.tld` shape (`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`). | Reference the owner via owner facts or an `EntityStore` contact id; never bake a literal address into the prompt. |
| `phone_pii` | Optional international prefix + area code + exchange + line shape (`+1 415-555-0123`, `(415) 555-5555`, `415.555.5555`). | Reference the owner or an EntityStore contact; never bake a literal number. |
| `absolute_path` | `^/`, `~/`, or `[A-Z]:\` followed by a path segment ≥ 2 chars. | Default packs ship across hosts. Use a relative reference, an owner-fact-derived path, or a connector capability check. |
| `hardcoded_iso_time` | Standalone `HH:MM`, `HH:MM:SS`, or full ISO datetimes — but **only** when the prompt does not reference an owner-fact time field. Allowlist references: `morningWindow`, `eveningWindow`, `quietHours`, the literal `HH:MM` placeholder. | Reference `ownerFact.morningWindow` / `eveningWindow` / `quietHours`, or use a trigger anchor (`relative_to_anchor`, `during_window`). |
| `embedded_conditional` | `if user`, `if user's`, `if owner`, `if the user is`, `if name is`, `unless owner`, `unless user`, `else if`, `case <X> when`, `when X = Y`, `when X: Y`, `when name is`. | Express as a registered gate (`task.shouldFire.gates`) or a `completionCheck` rule, not as content. |
| `hardcoded_url` | Concrete `http(s)://...` URLs. | Reference a connector capability instead of baking a host-specific URL. |
| `wave_narrative` | Internal milestone references: `Wave-1`, `Wave 2`, `W3-B`, `W1-A`, etc. | Wave/W-prefixed labels belong in comments and docs, not in runtime prompt content. |
| `prompt_slop` | AI-generated leftover markers: `TODO`, `FIXME`, `XXX`, `HACK` (uppercase, word-boundaried). | Finish the prompt or remove the placeholder. |

## False-positive guardrails

The corpus is designed to keep shipped pack content clean while still catching every documented violation. The current shipped packs (`daily-rhythm`, `morning-brief`, `quiet-user-watcher`, `followup-starter`, `inbox-triage-starter`, `habit-starters`) produce **zero** findings — see `bun run lint:default-packs` and the assertion in `test/default-packs.lint.test.ts`.

Specific false-positive guards:

- `hardcoded_iso_time` is suppressed when the prompt mentions `morningWindow` / `eveningWindow` / `quietHours` / `HH:MM`. This lets curators write "use morningWindow.start (e.g. 08:00)" without tripping.
- `pii_name` is word-boundary-anchored and case-sensitive, so `spinmarcora` and `marcosystem` do not match.
- `email_pii` requires a dot-separated TLD ≥ 2 chars after `@`, so `@mention` style references in copy do not match.
- `phone_pii` requires the area-code+exchange+line shape with separators, so digit clusters in copy ("the 1234 unread items") do not match.

If a curator hits a false positive on a legitimate prompt, the fix is to **rephrase**, not to allowlist. There is no per-record `// lint-ignore-line: <rule>` mechanism today.

## Adding new patterns

When a new hardcoding leak is observed:

1. Add the pattern to the regex constant in `src/default-packs/lint.ts`.
2. Mirror the change in `scripts/lint-default-packs.mjs` (the script duplicates the regex set so it can run without a TS runtime).
3. Add a synthetic-fail case in `test/default-packs.lint.synthetic-fail.test.ts`.
4. Document the addition here (rule kind + pattern + fix).

## Wave-3 promotion (W3-B)

Promotion shipped:

- The runner exits non-zero on any finding by default.
- `--allow-warnings` opts back into the legacy warnings-only behavior; it exists only so a maintainer can re-run locally during triage. CI must never invoke `--allow-warnings`.
- The corpus added five new rules over Wave 1: `email_pii`, `phone_pii`, `hardcoded_url`, `wave_narrative`, `prompt_slop`. The existing `embedded_conditional` rule was extended with `unless`, `else if`, and `case ... when`.
- `test/default-packs.lint.synthetic-fail.test.ts` pins the corpus: every rule has at least one synthetic prompt that must produce a finding; the false-positive guards have explicit assertions.
- Calibration audit: `bun run lint:default-packs` against the live shipped packs (post-W3-A tuning) produces zero findings — every rule has been validated against real content.

## Allowlist policy

There is no allowlist today. If a pack genuinely needs to embed one of the patterns (e.g. a tutorial pack referencing `08:00` as an example time), the curator either rephrases or escalates the concern. Wave-1 + Wave-3 explicitly do **not** ship a per-record `// lint-ignore-line: <rule>` mechanism; introducing one would defeat the static enforcement.

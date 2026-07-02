# #10757 — deterministic corpus honesty + per-plugin harness adoption

Follow-up to #8801. Two concrete, keyless-verifiable deliverables landed here.

## 1. Honest three-way corpus inventory (AC bullets 1 & 2)

Before: the scenario inventory (`check-scenario-workflow-coverage.mjs`) tagged
lanes as a binary `pr-deterministic | live-only`, so platform-gated scenarios
that **cannot run in any lane** (no self-hosted runner exists) were silently
lumped into `live-only` — an over-count of what live coverage actually exercises.

Now the inventory reports a **three-way split**, derived from the authoritative
gates (`lane` + the existing `requires.os` gate + an optional explicit
`deferred` annotation) so the counts cannot drift from reality:

- **keyless PR-deterministic** — runs on every PR with keys blanked
- **credentialed live-only** — runs on the live matrix with provider keys
- **deferred platform-gated** — needs an OS/runner that does not exist yet
  (currently the macOS shard: SelfControl/Screen-Time, iMessage/BlueBubbles, mac
  remote-control) — visible-but-deferred, attributed to the `eliza-e2e-macos`
  runner that would un-defer it.

See `inventory-README.md` (full generated report) and `corpus-lane-split.json`
(the split + the deferred-scenario list). Current split:

```
keyless PR-deterministic:            65
credentialed live-only (live matrix): 877
deferred platform-gated (no runner):  16   ← was hidden inside "live-only"
```

Implementation:
- `packages/scenario-runner/schema/index.{js,d.ts}` — additive `deferred`
  field (`{ reason, runner? }`) + `scenarioDeferral()` validator; a deferred
  scenario may not claim the `pr-deterministic` lane.
- `packages/scripts/check-scenario-workflow-coverage.mjs` — AST-reads
  `requires.os` + `deferred`, classifies each scenario, and renders the split +
  the deferred list. `AVAILABLE_OS_RUNNERS` is the single knob: add `"macos"`
  when the runner lands and the 16 macOS scenarios un-defer automatically.
- `packages/scenario-runner/src/scenario-deferral.test.ts` — 7 unit tests for
  the validator (shape, lane compatibility, eager validation).

No scenario files were hand-tagged — the macOS shard is classified from its
existing `requires: { os: "macos" }` gate, so this cannot drift from the gate.

## 2. Per-plugin keyless harness adoption (AC bullet 3)

Before: 8 plugins ship a `*.harness.test.ts` suite, but only **anthropic** and
**discord** were CI-gated in `keyless-harness-e2e.yml`. The other 6 were excluded
from default vitest runs (each plugin's `vitest.config.ts` excludes
`*.harness.test.ts`), so they could silently rot.

Now `keyless-harness-e2e.yml` gates **7** suites — the two originals plus the 5
model-provider suites verified to pass keyless locally (keys blanked):

| suite | keyless result (local) |
| --- | --- |
| plugin-openai | 2 passed |
| plugin-groq | 2 passed |
| plugin-openrouter | 2 passed |
| plugin-google-genai | 2 passed |
| plugin-telegram | 1 passed |

`plugin-goals` also ships a harness suite but is **not** gated here: it depends
on the built `@elizaos/registry` first-party subpath and could not be confirmed
keyless-green outside a full workspace build. Documented in the workflow comment
as a follow-up rather than gated unverified (per the AC: "no scenario/harness is
claimed unless it passes").

## Verification commands (keyless, no external keys)

```bash
node packages/scripts/check-scenario-workflow-coverage.mjs --report-dir <out>   # three-way split
bun run --cwd packages/scenario-runner test scenario-deferral                    # 7 passed
bun run --cwd packages/scenario-runner test scenario-pr-workflow                 # 11 passed (unchanged)
bun run --cwd plugins/plugin-openai test:harness                                 # 2 passed  (+ groq/openrouter/google-genai/telegram)
```

## Not in scope here (documented blockers)
- Converting live-only scenarios to `pr-deterministic`: only deterministic
  action-dispatch scenarios qualify; forcing model-judged ones would be exactly
  the dishonest count this ratchet prevents. Deferred to a targeted follow-up.
- Live-drift for slack/discord-rest/telegram-bot-http/linear/shopify: needs each
  provider's secret in CI (credential-blocked).
- Actually running the macOS shard: needs the `eliza-e2e-macos` self-hosted
  runner (operator/infra task).

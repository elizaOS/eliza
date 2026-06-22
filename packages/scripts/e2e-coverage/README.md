# Per-plugin keyless-e2e coverage gate

A plugin that exposes an agent surface — actions and/or a message connector —
but ships **zero keyless e2e coverage** is a broken pipeline: a capability users
reach with no zero-cost regression test. This gate flags exactly that.

"Keyless e2e" = a scenario that runs on a PR under the deterministic LLM proxy
(`SCENARIO_USE_LLM_PROXY=1`) with **no credentials**:

- any scenario in `packages/scenario-runner/test/scenarios` (the deterministic
  corpus, which runs keyless by construction), or
- a scenario in the big `packages/test/scenarios` corpus tagged
  `lane: "pr-deterministic"`.

A plugin "has keyless e2e" when at least one such scenario names it in its
`requires.plugins`.

## Files

- `inventory.ts` — static (source-only, no plugin import) discovery of each
  checked-out plugin's surface (`hasActions` / `hasConnector`) and the keyless
  scenarios that require it.
- `check-e2e-coverage.ts` — the gate. Ratchets the set of surface-but-uncovered
  plugins against `keyless-e2e-baseline.json`.
- `keyless-e2e-baseline.json` — the ratchet. Lists plugins that have a surface
  but no keyless e2e **yet**. It may only shrink.
- `check-e2e-coverage.test.ts` — unit tests for the inventory + gate, including
  the ratchet failure modes.

## Run

```bash
bun run audit:e2e-coverage          # the gate (exit 1 on failure)
bun run audit:e2e-coverage:test     # the unit tests
bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --list-uncovered
bun packages/scripts/e2e-coverage/check-e2e-coverage.ts --json
```

## Rules (ratchet)

1. Every plugin with a surface must either have a keyless scenario or appear in
   `keyless-e2e-baseline.json`.
2. The baseline may only **shrink**. The gate fails if a baselined plugin is now
   covered, no longer has a surface, or no longer exists — forcing the stale
   entry out so coverage never silently regresses.
3. A new plugin with a surface that is neither covered nor baselined fails the
   gate. Add a keyless (`lane: "pr-deterministic"`) scenario, or add it to the
   baseline with justification.

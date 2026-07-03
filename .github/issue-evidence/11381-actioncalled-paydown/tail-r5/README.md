# #11381 tail — round-4 salvage landing (BASELINE 36 → 25)

Rescued from `rescue/11381-actioncalled-paydown-r4-local` (round-4 salvage
commit `dd9a1aa3e7`, cut off by the credit wall before PR #11575 merged):
11 more actionCalled-only scenarios given real effect finalChecks —
`ainex/stand`, `finances/owner-finances-dashboard`, and 9 `selfcontrol/*`
scenarios. `action-effect-ratchet.test.ts` `BASELINE` lowered 36 → 25 in
lockstep.

## Artifacts (all real command output / runner reports)

- `ratchet-enumeration-red-baseline0.txt` — ratchet run with `BASELINE=0`:
  RED, enumerates exactly the 25 remaining offenders on this branch.
- `ratchet-green-baseline25.txt` — `bun run --cwd packages/scenario-runner
  test -- src/action-effect-ratchet.test.ts` at `BASELINE=25`: 2/2 pass.
- `ainex-stand-deterministic-green.matrix.json` — full scenario-runner report:
  `ainex.stand` (lane `pr-deterministic`) run keyless
  (`SCENARIO_USE_LLM_PROXY=1 SCENARIO_LLM_PROXY_STRICT=1`) with the new
  bridge-effect predicate — passed.
- `finances-dashboard-deterministic-green.matrix.json` — same lane:
  `finances.owner-finances-dashboard` with the new composite-read predicate —
  passed; the captured action result shows the real `data.dashboard`
  payload the predicate reads.
- `finances-fail-without-fix-red.matrix.json` — fail-without-fix proof:
  predicate temporarily pointed at `dashboard.spendingWRONGFIELD` → scenario
  goes RED with `expected dashboard.spending {transactionCount, windowDays}
  numbers from the app_finances read, saw {...real payload...}`; flip
  reverted before commit.

## Lane notes

- The 9 `selfcontrol/*` conversions are `lane: "live-only"` scenarios (they
  need a real blocker device); their new `custom` predicates are validated
  statically by the ratchet enumeration (they no longer count as
  actionCalled-only) and use the same `_helpers/effect-assertions.ts`
  helpers exercised green in the two deterministic runs above.
- Remaining debt after this tail: **25** direct actionCalled-only scenarios
  (list in `ratchet-enumeration-red-baseline0.txt`).

# lifeops-quality — agent guide

Recorded-baseline LifeOps quality benchmarks (#10723). Full docs: `README.md`.

- **Two lanes, both keyless + deterministic.** `triage/` drives the REAL
  plugin-inbox classifier (`classifyMessages`) over a committed 56-item
  corpus with a committed fixed-quality mock model; `timeliness/` replays
  the REAL PA scheduled-task tick (`processDueScheduledTasks`) on PGlite
  over two committed 2026 DST windows with an injected clock.
- **Never reimplement the code under test here.** The gates import it from
  `plugins/plugin-inbox` and `plugins/plugin-personal-assistant` directly.
  The timeliness oracle must never call the production cron walker — its
  expectations are hand-authored instants (unit lane cross-checks them via
  Intl tzdata).
- **`baseline.json` is a recorded reference, `budgets.json` is the gate.**
  Corpus/fixture edits require re-recording the baseline in the same change
  (run the gates, copy `results/*.json` blocks). Floors are calibrated to
  trip on one additional misclassification / any fire-count defect — the
  unit lane enforces that calibration; don't loosen floors to make a red
  gate green.
- **Fire counts are contracts, not tolerances:** missed/duplicate/early/
  occurrence-mismatch must stay exactly 0, and `maxDeviationMs` stays at
  the tick cadence (300000ms).
- Lanes: `bun run test` (unit, fast) · `bun run bench[:triage|:timeliness]`
  (gates; timeliness ~3min). CI: `.github/workflows/lifeops-quality-bench.yml`.
- `vitest.gate.config.ts` reuses plugin-personal-assistant's
  `vitest.src-integration.config.ts` wiring — if the gate lane breaks on
  resolve/alias errors, fix it there, not with a parallel config here.

`CLAUDE.md` and `AGENTS.md` are identical — edit `CLAUDE.md`, copy to
`AGENTS.md`.

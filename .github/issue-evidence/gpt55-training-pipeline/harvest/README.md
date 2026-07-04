# Stage 2 harvest output root

`harvest-runner.mjs` writes here: one dir per corpus item:

  <family>/<dir-slug>/<item-slug>/{report.json, native.jsonl, native.jsonl.manifest.json, verdict.json, run/, stdout.log, stderr.log}

Stage 1 populated 2 sample scenario items (deterministic proxy) as a driver-mechanics proof:
  scenario/packages_scenario-runner_test_scenarios/background-live/
  scenario/packages_scenario-runner_test_scenarios/cloud-apps-read-core/

Both `status=failed` under the offline deterministic proxy (these scenarios
expect live-LLM behavior). native.jsonl carries real eliza_native_v1 rows with
format/schemaVersion/scenarioStatus. Stage 2 re-runs with the gpt-5.5 Codex
provider env, where passing rows become gold training data.

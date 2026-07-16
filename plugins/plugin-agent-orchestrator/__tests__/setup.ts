/**
 * Unit-test bootstrap keeps the durable Smithers task path off so create-task
 * coverage exercises the fast direct-prompt path. The durable runner, executor,
 * and integration glue are tested directly in smithers-task suites, while
 * production defaults remain enabled through shouldUseSmithersTaskRunner.
 */
if (process.env.ELIZA_ORCHESTRATOR_SMITHERS === undefined) {
  process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
}

// The deterministic completion-residuals gate (production default ON) probes
// the reporting session's workdir with real git. Event-bridge/lifecycle suites
// seed placeholder workdirs like "/repo", which the fail-closed gate would
// (correctly) flag as unverifiable and re-engage — changing the states those
// suites pin. Default it off here; the gate's own suites
// (completion-residuals.test.ts, auto-goal-verify.test.ts) re-enable it against
// REAL temp git workspaces.
if (process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE === undefined) {
  process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = "0";
}

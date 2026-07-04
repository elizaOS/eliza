/**
 * Unit-test bootstrap keeps the durable Smithers task path off so create-task
 * coverage exercises the fast direct-prompt path. The durable runner, executor,
 * and integration glue are tested directly in smithers-task suites, while
 * production defaults remain enabled through shouldUseSmithersTaskRunner.
 */
if (process.env.ELIZA_ORCHESTRATOR_SMITHERS === undefined) {
  process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
}

// Default the durable Smithers task path OFF for unit tests so create-task tests
// exercise the fast direct-prompt path (no per-task bun subprocess). The durable
// runner, executor, and integration glue are tested directly in
// smithers-task-*.test.ts. Production defaults ON (see shouldUseSmithersTaskRunner).
if (process.env.ELIZA_ORCHESTRATOR_SMITHERS === undefined) {
  process.env.ELIZA_ORCHESTRATOR_SMITHERS = "0";
}

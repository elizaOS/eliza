/**
 * Measured entry imported by confidential-bootstrap.mjs after it authenticates
 * the encrypted launch environment. It only selects the agent's `start`
 * command; configuration comes from the measured compose environment.
 */
process.argv.push("start");
await import("/app/packages/agent/dist/bin.js");

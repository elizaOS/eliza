/**
 * E2E test runner for the TypeScript A2A server.
 *
 * Starts the server on an ephemeral port, runs the test client, then shuts down.
 */

import { startServer } from "./server";
import { runA2ATestClient } from "./test-client";

if (import.meta.main) {
  // Skip this live A2A e2e in the keyless workspace sweep (run-all-tests.mjs,
  // ELIZA_LIVE_TEST=0); the server refuses to start without a provider key.
  const hasProviderKey = [
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "ANTHROPIC_API_KEY",
    "ELIZA_API_KEY",
  ].some((name) => process.env[name]?.trim());
  if (!hasProviderKey) {
    console.log("[a2a] skipped: no inference provider key configured.");
    process.exit(0);
  }
  const { port, close } = await startServer({ port: 0 });
  const baseUrl = `http://localhost:${port}`;
  let exitCode = 0;
  try {
    await runA2ATestClient(baseUrl);
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    await close();
  }
  process.exit(exitCode);
}

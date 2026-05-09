/**
 * E2E test runner for the TypeScript A2A server.
 *
 * Starts the server on an ephemeral port, runs the test client, then shuts down.
 */

import { startServer } from "./server";
import { runA2ATestClient } from "./test-client";

if (import.meta.main) {
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

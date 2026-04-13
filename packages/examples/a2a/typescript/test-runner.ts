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
  try {
    await runA2ATestClient(baseUrl);
  } finally {
    await close();
  }
}


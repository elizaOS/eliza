/**
 * Test Setup - MUST RUN BEFORE ANY TEST CODE
 *
 * CRITICAL: This ensures tests run against local endpoints, NOT production!
 * Without this, tests would hit https://www.elizacloud.ai which is VERY BAD.
 *
 * Environment variables:
 * - SKIP_SERVER_CHECK=true: Skip the local server check (for unit tests in CI)
 */

import "./load-env";

const LOCAL_SERVER_URL = "http://localhost:3000";

/**
 * Verify local server is running before any tests execute
 * This BLOCKS tests from running if the server is down
 *
 * Can be skipped by setting SKIP_SERVER_CHECK=true (useful for unit tests in CI)
 */
async function verifyLocalServerRunning(): Promise<void> {
  // Skip server check if explicitly disabled (for unit tests that don't need a server)
  if (process.env.SKIP_SERVER_CHECK === "true") {
    console.log("\n[Test Setup] Server check skipped (SKIP_SERVER_CHECK=true)");
    return;
  }

  console.log("\n[Test Setup] Verifying local server is running...");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const healthEndpoint = `${LOCAL_SERVER_URL}/api/health`;
  const response = await fetch(healthEndpoint, {
    signal: controller.signal,
    method: "GET",
  }).catch((error: Error) => {
    clearTimeout(timeout);
    throw new Error(
      `\n${"=".repeat(60)}\n` +
        `❌ LOCAL SERVER NOT RUNNING\n` +
        `${"=".repeat(60)}\n\n` +
        `Runtime tests require the local server at ${LOCAL_SERVER_URL}\n` +
        `Please start the server first:\n\n` +
        `  bun run dev\n\n` +
        `Or skip this check for unit tests:\n\n` +
        `  SKIP_SERVER_CHECK=true bun test ...\n\n` +
        `Error: ${error.message}\n` +
        `${"=".repeat(60)}\n`,
    );
  });

  clearTimeout(timeout);

  // Accept any response as "server is running"
  // 401/403 = server running but auth required (expected for some endpoints)
  // 200 = healthy
  // 5xx = server error (should still proceed, server is technically running)
  console.log(`  ✅ Local server running at ${LOCAL_SERVER_URL} (status: ${response.status})`);
}

// Run verification synchronously at module load time
// This ensures tests don't even start if server is down
const serverCheck = verifyLocalServerRunning();

// Export the promise so tests can await it if needed
export { serverCheck };

// Log confirmation that test environment is configured
console.log("[Test Setup] Environment configured for LOCAL testing:");
console.log(`  NODE_ENV: ${process.env.NODE_ENV}`);
console.log(`  ELIZAOS_CLOUD_BASE_URL: ${process.env.ELIZAOS_CLOUD_BASE_URL}`);
console.log(`  TEST_BLOCK_ANONYMOUS: ${process.env.TEST_BLOCK_ANONYMOUS}`);

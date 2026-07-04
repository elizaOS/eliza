/**
 * Real local agent provisioning check — executed, not mocked, NO secret/model.
 *
 * Boots an actual AgentRuntime on a real PGLite database and the real app-core
 * HTTP API (the same `startApiServer` the desktop/CLI shells use), then asserts
 * the agent is genuinely provisioned and serving. This is the "local provisioning
 * works for real" proof the stub lanes cannot give. Because it needs no
 * provider/cloud key and no native llama (`withLLM:false` skips the local
 * embedding plugin), it runs and passes in CI without secrets.
 *
 * Run via the repo's tsx runner (real module resolution — vitest's aliasing
 * stubs out plugin handlers like edge-tts and breaks runtime.start):
 *   node packages/app-core/scripts/run-node-tsx.mjs \
 *     packages/app-core/scripts/check-real-local-provisioning.ts
 *
 * Exit 0 = all assertions passed; exit 1 = a failure (with the reason logged).
 */

import assert from "node:assert/strict";
import { startApiServer } from "../src/api/server.ts";
import { useIsolatedConfigEnv } from "../test/helpers/isolated-config.ts";
import { createRealTestRuntime } from "../test/helpers/real-runtime.ts";

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `${url} should return 200, got ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  // Isolate ELIZA_CONFIG_PATH so first-run state is fresh per run (otherwise the
  // completion this check writes leaks into the next run's "starts incomplete").
  const configEnv = useIsolatedConfigEnv("eliza-local-prov-check-");
  const runtimeResult = await createRealTestRuntime({
    characterName: "LocalProvisioningCheck",
  });
  const server = await startApiServer({
    port: 0,
    runtime: runtimeResult.runtime,
    skipDeferredStartupWork: true,
  });
  const baseUrl = `http://127.0.0.1:${server.port}`;
  console.log(`[local-prov] real API up at ${baseUrl} in ${Date.now() - t0}ms`);

  try {
    // 1. A real runtime + real DB came up — not a stub returning a canned literal.
    const health = await getJson(`${baseUrl}/api/health`);
    assert.equal(health.ready, true, "health.ready must be true");
    assert.equal(health.runtime, "ok", "health.runtime must be ok");
    assert.equal(health.database, "ok", "health.database must be ok");
    const plugins = health.plugins as { loaded: number; failed: number };
    assert.ok(plugins.loaded > 0, "at least one plugin must load");
    assert.equal(plugins.failed, 0, "no plugin may fail to load");
    console.log(
      `[local-prov] PASS health: ready, db ok, ${plugins.loaded} plugins, 0 failed`,
    );

    // 2. The agent reports a real running status.
    const status = await getJson(`${baseUrl}/api/status`);
    assert.equal(status.state, "running", "agent state must be running");
    assert.equal(
      status.agentName,
      "LocalProvisioningCheck",
      "agent name must match the provisioned character",
    );
    console.log(`[local-prov] PASS status: running as ${status.agentName}`);

    // 3. Provisioning the agent through first-run flips completion to true.
    const before = await getJson(`${baseUrl}/api/first-run/status`);
    assert.equal(before.complete, false, "first-run must start incomplete");
    const post = await fetch(`${baseUrl}/api/first-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local Provisioned Agent" }),
    });
    assert.ok(post.ok, `first-run POST must succeed, got ${post.status}`);
    const after = await getJson(`${baseUrl}/api/first-run/status`);
    assert.equal(after.complete, true, "first-run must report complete");
    console.log("[local-prov] PASS provisioning: first-run completed");
  } finally {
    // error-policy:J6 best-effort teardown of the harness fixtures; a cleanup
    // failure must not mask the assertion outcome that preceded it.
    await server.close().catch(() => undefined);
    await runtimeResult.cleanup().catch(() => undefined);
    await configEnv.restore().catch(() => undefined);
  }

  console.log(
    `[local-prov] ALL ASSERTIONS PASSED — real local provisioning works (${Date.now() - t0}ms)`,
  );
}

main()
  .then(() => {
    // This is a one-shot CI proof script. After the real runtime cleanup above,
    // force the process closed so stray server/watch handles cannot hold the job
    // open until GitHub cancels it.
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      `[local-prov] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  });

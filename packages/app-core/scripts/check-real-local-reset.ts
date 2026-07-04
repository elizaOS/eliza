/**
 * Real local reset — executed, NO secret and NO native llama. Proves the full
 * reset → re-provision cycle works for real: it seeds a real PGLite database
 * with a conversation through the real conversation routes, drives the actual
 * reset DB wipe (`_clearCompatPgliteDataDirForTests` against the REAL pglite
 * dir the runtime is running on), then re-boots a fresh runtime on the SAME
 * config + data dir and asserts the agent is back to a clean first-run state
 * with an EMPTY conversation list.
 *
 * The only deterministic part is token generation, supplied by the in-process
 * deterministic LLM proxy (a real Plugin with real model handlers). Everything
 * else — runtime, DB, conversation persistence, first-run provisioning, the
 * data-dir wipe — is the real machinery. Because the proxy provides every text
 * model + embedding handler, it needs no provider/cloud key and no llama, so it
 * runs and passes in CI without secrets.
 *
 * Run via the repo's tsx runner (real module resolution — vitest's aliasing
 * stubs out plugin handlers and breaks runtime.start):
 *   node packages/app-core/scripts/run-node-tsx.mjs \
 *     packages/app-core/scripts/check-real-local-reset.ts
 *
 * Exit 0 = all assertions passed; exit 1 = a failure (with the reason logged).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  clearPersistedFirstRunConfig,
  loadElizaConfig,
  saveElizaConfig,
} from "@elizaos/agent";
import { createDeterministicLlmProxyPlugin } from "../../test/mocks/helpers/llm-proxy-plugin.ts";
import {
  _clearCompatPgliteDataDirForTests,
  startApiServer,
} from "../src/api/server.ts";
import {
  createConversation,
  postConversationMessage,
  req,
} from "../test/helpers/http.ts";
import { useIsolatedConfigEnv } from "../test/helpers/isolated-config.ts";
import { createRealTestRuntime } from "../test/helpers/real-runtime.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const CLEANUP_HELPER_SCRIPT = path.join(
  REPO_ROOT,
  "packages",
  "scripts",
  "rm-path-recursive.mjs",
);

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  assert.equal(res.status, 200, `${url} should return 200, got ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function listConversations(data: Record<string, unknown>): unknown[] {
  return Array.isArray(data.conversations) ? data.conversations : [];
}

async function main(): Promise<void> {
  const t0 = Date.now();
  // Isolate ELIZA_CONFIG_PATH so first-run state is fresh per run and the reset
  // mutates a throwaway eliza.json, never the developer's real config.
  const configEnv = useIsolatedConfigEnv("eliza-local-reset-check-");

  // A stable PGLite data dir that the reset wipe will accept. The reset safety
  // guard refuses to delete any dir whose basename is not ".elizadb", and
  // `createRealTestRuntime` exports the actual dir it ran on so the wipe and the
  // re-boot both target the identical real path.
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-reset-data-"));
  const pgliteDir = path.join(dataRoot, ".elizadb");
  fs.mkdirSync(pgliteDir, { recursive: true });

  try {
    // ── Phase 1: boot, provision, seed a real conversation ──────────────────
    const proxy = createDeterministicLlmProxyPlugin({
      failOnUnhandledAction: false,
    });
    const first = await createRealTestRuntime({
      characterName: "LocalResetCheck",
      plugins: [proxy],
      pgliteDir,
      // We own the dir lifecycle (the reset wipe deletes it); don't let cleanup
      // race the wipe or remove a dir the reboot still needs.
      removePgliteDirOnCleanup: false,
    });
    assert.equal(
      first.pgliteDir,
      pgliteDir,
      "the runtime must run on the data dir we control",
    );
    let server = await startApiServer({
      port: 0,
      runtime: first.runtime,
      skipDeferredStartupWork: true,
    });
    let port = server.port;
    console.log(
      `[local-reset] real API up on :${port} in ${Date.now() - t0}ms`,
    );

    const firstRun = await fetch(`http://127.0.0.1:${port}/api/first-run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local Reset Agent" }),
    });
    assert.ok(firstRun.ok, `first-run must succeed, got ${firstRun.status}`);
    const provisioned = await getJson(
      `http://127.0.0.1:${port}/api/first-run/status`,
    );
    assert.equal(
      provisioned.complete,
      true,
      "first-run must report complete after provisioning",
    );
    console.log("[local-reset] PASS provisioning: first-run completed");

    const conv = await createConversation(port, { title: "reset seed" });
    assert.equal(conv.status, 200, "conversation creation must return 200");
    assert.ok(conv.conversationId, "a conversation id must be returned");
    const sent = await postConversationMessage(
      port,
      conv.conversationId,
      { text: "Remember this before the reset." },
      undefined,
      { timeoutMs: 90_000 },
    );
    assert.equal(sent.status, 200, "message POST must return 200");

    const seeded = await req(port, "GET", "/api/conversations");
    assert.equal(seeded.status, 200, "conversation list must return 200");
    const seededList = listConversations(seeded.data);
    assert.ok(
      seededList.length > 0,
      "the conversation list must be non-empty after seeding",
    );
    console.log(
      `[local-reset] PASS seed: ${seededList.length} real conversation(s) persisted`,
    );
    assert.ok(
      fs.existsSync(pgliteDir),
      "the PGLite data dir must exist before reset",
    );

    // ── Phase 2: drive the real reset DB wipe ───────────────────────────────
    // Stop the API server first so it isn't holding the runtime we're about to
    // tear down; the wipe stops the runtime and removes the real data dir.
    // error-policy:J6 best-effort server close before the wipe; a close failure
    // does not change what the wipe assertions below verify.
    await server.close().catch(() => undefined);
    const config = loadElizaConfig();
    await _clearCompatPgliteDataDirForTests(first.runtime, config);
    assert.equal(
      fs.existsSync(pgliteDir),
      false,
      "reset must delete the PGLite data dir",
    );
    console.log(`[local-reset] PASS reset: PGLite data dir wiped ${pgliteDir}`);

    // Clear the persisted first-run completion the same way the reset route
    // does, so the re-boot genuinely starts from a fresh first-run state.
    clearPersistedFirstRunConfig(config);
    saveElizaConfig(config);

    // Fully tear down the first runtime so its PGLite client manager (a
    // process-global singleton in @elizaos/plugin-sql, reused while not
    // shutting down) is released. In production the reset route is followed by
    // an API-process restart, which gets a fresh process + singleton; this
    // in-process re-boot must release the stale manager first or it would
    // reattach to the now-deleted data dir and fail migrations.
    // error-policy:J6 best-effort runtime teardown to release the SQL manager.
    await first.cleanup().catch(() => undefined);

    // ── Phase 3: re-boot a fresh runtime on the SAME dir + assert clean ─────
    const proxy2 = createDeterministicLlmProxyPlugin({
      failOnUnhandledAction: false,
    });
    const second = await createRealTestRuntime({
      characterName: "LocalResetCheck",
      plugins: [proxy2],
      pgliteDir,
      removePgliteDirOnCleanup: false,
    });
    try {
      server = await startApiServer({
        port: 0,
        runtime: second.runtime,
        skipDeferredStartupWork: true,
      });
      port = server.port;
      console.log(`[local-reset] re-booted fresh runtime on :${port}`);

      const health = await getJson(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.ready, true, "post-reset health.ready must be true");
      assert.equal(
        health.database,
        "ok",
        "post-reset health.database must be ok",
      );
      console.log("[local-reset] PASS post-reset health: ready, db ok");

      const status = await getJson(
        `http://127.0.0.1:${port}/api/first-run/status`,
      );
      assert.equal(
        status.complete,
        false,
        "first-run must report incomplete again after reset",
      );
      console.log("[local-reset] PASS post-reset first-run: incomplete again");

      const afterList = await req(port, "GET", "/api/conversations");
      assert.equal(
        afterList.status,
        200,
        "post-reset conversation list must return 200",
      );
      const conversations = listConversations(afterList.data);
      assert.equal(
        conversations.length,
        0,
        `the conversation list must be EMPTY after reset, got ${conversations.length}`,
      );
      console.log("[local-reset] PASS post-reset: conversation list is empty");
    } finally {
      // error-policy:J6 best-effort teardown of the re-booted runtime.
      await server.close().catch(() => undefined);
      await second.cleanup().catch(() => undefined);
    }
  } finally {
    // error-policy:J6 best-effort restore of the mutated process env.
    await configEnv.restore().catch(() => undefined);
    try {
      execFileSync(process.execPath, [CLEANUP_HELPER_SCRIPT, dataRoot], {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
    } catch {
      // best-effort temp cleanup
    }
  }

  console.log(
    `[local-reset] ALL ASSERTIONS PASSED — real local reset + re-provision works (${Date.now() - t0}ms)`,
  );
}

main()
  .then(() => {
    // Two real runtimes booted across the reset cycle; their PGLite sync /
    // trajectory write-back timers keep the event loop alive after teardown.
    // All assertions have passed, so exit explicitly rather than hang.
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      `[local-reset] FAILED: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    process.exit(1);
  });

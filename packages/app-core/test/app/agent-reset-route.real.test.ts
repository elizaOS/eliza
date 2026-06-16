/**
 * Real-HTTP coverage for the full `POST /api/agent/reset` handler.
 *
 * Unlike `server-reset-hop.test.ts` (which calls the extracted
 * `_clearCompatPgliteDataDirForTests` helper directly), this boots a real
 * `AgentRuntime` on a real PGLite database behind the real app-core HTTP API
 * and drives the reset over a real loopback port. That exercises everything the
 * route does in one shot: the sensitive-route auth gate, runtime stop, the
 * `.elizadb` data-dir wipe, nulling `state.current`, clearing the persisted
 * first-run config, and clearing the sealed cloud-secret store.
 *
 * Keyless: the deterministic LLM proxy supplies every model handler, so no
 * provider/cloud key and no native llama are needed.
 *
 * Loopback requests from 127.0.0.1 are trusted by
 * `ensureCompatSensitiveRouteAuthorized` when no `ELIZA_API_TOKEN` is set and
 * `ELIZA_REQUIRE_LOCAL_AUTH` / `ELIZA_CLOUD_PROVISIONED` are unset — the same
 * path the desktop dashboard uses on-device. We assert those are clear so the
 * reset is reachable exactly as in production local mode.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  _resetCloudSecretsForTesting,
  getCloudSecret,
  scrubCloudSecretsFromEnv,
} from "@elizaos/shared/elizacloud/cloud-secrets";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDeterministicLlmProxyPlugin } from "../../../test/mocks/helpers/llm-proxy-plugin.ts";
import {
  getSharedCompatRuntimeState,
  startApiServer,
} from "../../src/api/server.ts";
import { req } from "../helpers/http.ts";
import { useIsolatedConfigEnv } from "../helpers/isolated-config.ts";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

describe("POST /api/agent/reset (real HTTP handler)", () => {
  let configEnv: ReturnType<typeof useIsolatedConfigEnv> | null = null;
  let runtimeResult: Awaited<ReturnType<typeof createRealTestRuntime>> | null =
    null;
  let server: Awaited<ReturnType<typeof startApiServer>> | null = null;
  let dataRoot: string | null = null;
  let pgliteDir: string | null = null;

  // The local-trust path requires these to be unset; the loopback dashboard
  // request the reset route serves is otherwise rejected as a sensitive route.
  const prev = {
    requireLocalAuth: process.env.ELIZA_REQUIRE_LOCAL_AUTH,
    cloudProvisioned: process.env.ELIZA_CLOUD_PROVISIONED,
    apiToken: process.env.ELIZA_API_TOKEN,
  };

  beforeEach(async () => {
    delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
    delete process.env.ELIZA_API_TOKEN;
    _resetCloudSecretsForTesting();

    configEnv = useIsolatedConfigEnv("agent-reset-route-");

    dataRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "agent-reset-route-data-"),
    );
    pgliteDir = path.join(dataRoot, ".elizadb");
    fs.mkdirSync(pgliteDir, { recursive: true });

    runtimeResult = await createRealTestRuntime({
      characterName: "AgentResetRouteLive",
      plugins: [
        createDeterministicLlmProxyPlugin({ failOnUnhandledAction: false }),
      ],
      pgliteDir,
      // The reset handler deletes this dir; own its lifecycle explicitly so
      // runtime cleanup doesn't race the wipe.
      removePgliteDirOnCleanup: false,
    });
    server = await startApiServer({
      port: 0,
      runtime: runtimeResult.runtime,
      skipDeferredStartupWork: true,
    });
  }, 120_000);

  afterEach(async () => {
    await server?.close().catch(() => undefined);
    await runtimeResult?.cleanup().catch(() => undefined);
    await configEnv?.restore().catch(() => undefined);
    _resetCloudSecretsForTesting();
    if (dataRoot) {
      await fsp
        .rm(dataRoot, { recursive: true, force: true })
        .catch(() => undefined);
    }
    for (const [key, value] of [
      ["ELIZA_REQUIRE_LOCAL_AUTH", prev.requireLocalAuth],
      ["ELIZA_CLOUD_PROVISIONED", prev.cloudProvisioned],
      ["ELIZA_API_TOKEN", prev.apiToken],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("resets the agent: 200 {ok:true}, state nulled, first-run cleared, data dir gone, cloud secrets cleared", async () => {
    const port = server?.port ?? 0;

    // Provision so there is persisted first-run state to clear.
    const firstRun = await req(port, "POST", "/api/first-run", {
      name: "Reset Route Agent",
    });
    expect(firstRun.status).toBe(200);
    const provisioned = await req(port, "GET", "/api/first-run/status");
    expect(provisioned.data.complete).toBe(true);

    // Seed the sealed cloud-secret store (the reset clears it, not process.env).
    process.env.ELIZAOS_CLOUD_API_KEY = "reset-route-cloud-key";
    scrubCloudSecretsFromEnv();
    expect(getCloudSecret("ELIZAOS_CLOUD_API_KEY")).toBe(
      "reset-route-cloud-key",
    );

    // The runtime must be the live one before reset.
    expect(getSharedCompatRuntimeState().current).not.toBeNull();
    expect(fs.existsSync(pgliteDir ?? "")).toBe(true);

    const reset = await req(port, "POST", "/api/agent/reset", "{}", undefined, {
      timeoutMs: 90_000,
    });
    expect(reset.status).toBe(200);
    expect(reset.data).toEqual({ ok: true });

    // state.current nulled.
    expect(getSharedCompatRuntimeState().current).toBeNull();

    // The PGLite data dir is gone (conversations/knowledge/trajectories wiped).
    expect(fs.existsSync(pgliteDir ?? "")).toBe(false);

    // Persisted first-run config cleared (re-reading status reports incomplete).
    const afterStatus = await req(port, "GET", "/api/first-run/status");
    expect(afterStatus.data.complete).toBe(false);

    const savedConfig = JSON.parse(
      await fsp.readFile(configEnv?.configPath ?? "", "utf8"),
    ) as {
      meta?: { firstRunComplete?: unknown };
      agents?: { list?: unknown[] };
    };
    expect(savedConfig.meta?.firstRunComplete).toBeUndefined();
    expect(savedConfig.agents?.list ?? []).toEqual([]);

    // Sealed cloud secrets cleared.
    expect(getCloudSecret("ELIZAOS_CLOUD_API_KEY")).toBeUndefined();

    // The runtime is already torn down; null it so afterEach cleanup is a no-op.
    runtimeResult = null;
  }, 120_000);
});

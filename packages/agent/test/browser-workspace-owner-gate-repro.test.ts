/**
 * Tip repro: a paired USER guest can hit /api/browser-workspace/* because
 * isOwnerOnlyApiRequest omits the prefix (post-#38121 tip). With the fix,
 * every method under the prefix returns 403 to the guest.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  _resetAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";

const OWNER_TOKEN = "owner-static-token-0123456789abcdef0123456789";

it("refuses browser-workspace reads and writes to a paired USER session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-bw-owner-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: OWNER_TOKEN,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({ meta: { firstRunComplete: true } }),
  );
  setAgentHostBridge({
    resolveHttpRequestAuthorization: async (req: {
      headers: Record<string, unknown>;
    }) =>
      req.headers.authorization === "Bearer guest-session-id"
        ? { ok: true, role: "USER", identityId: "guest-identity" }
        : { ok: false, role: "NONE" },
  } as never);
  const runtime = new AgentRuntime({
    character: { name: "BwOwner", bio: [], settings: {} },
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(join(directory, "s.sqlite"), runtime.agentId),
  );
  let server: Awaited<ReturnType<typeof startApiServer>> | undefined;
  try {
    await runtime.init();
    server = await startApiServer({
      port: 0,
      runtime,
      skipDeferredStartupWork: true,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const send = (token: string, path: string, init: RequestInit = {}) =>
      fetch(base + path, {
        ...init,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
      });

    const guestGet = await send("guest-session-id", "/api/browser-workspace");
    const guestTabs = await send(
      "guest-session-id",
      "/api/browser-workspace/tabs",
      {
        method: "POST",
        body: JSON.stringify({ url: "https://example.invalid/" }),
      },
    );
    const guestCommand = await send(
      "guest-session-id",
      "/api/browser-workspace/command",
      {
        method: "POST",
        body: JSON.stringify({ subaction: "snapshot" }),
      },
    );
    // Tip without the gate: guest GET is 200 (empty workspace). With the
    // gate every call is 403 before the handler runs.
    expect(guestGet.status, "GET /api/browser-workspace").toBe(403);
    expect(guestTabs.status, "POST /api/browser-workspace/tabs").toBe(403);
    expect(guestCommand.status, "POST /api/browser-workspace/command").toBe(
      403,
    );

    // Owner still reaches the handler (200 empty snapshot or 503 if the
    // plugin is unavailable — either is fine; must not be 403).
    const ownerGet = await send(OWNER_TOKEN, "/api/browser-workspace");
    expect(ownerGet.status).not.toBe(403);
  } finally {
    await server?.close();
    _resetAgentHostBridge();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

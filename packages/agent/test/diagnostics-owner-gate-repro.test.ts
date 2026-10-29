/**
 * Tip repro: a paired USER guest can hit /api/logs and /api/security/audit
 * because isOwnerOnlyApiRequest omits both (post-#38121 tip). With the fix,
 * every method under those paths returns 403 to the guest.
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

it("refuses diagnostics log and security-audit access to a paired USER session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-diag-owner-"));
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
    character: { name: "DiagOwner", bio: [], settings: {} },
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
          ...(init.headers ?? {}),
        },
      });

    const guestRequests: [string, RequestInit][] = [
      ["/api/logs", {}],
      ["/api/logs", { method: "DELETE" }],
      [
        "/api/logs/export",
        { method: "POST", body: JSON.stringify({ format: "json" }) },
      ],
      ["/api/security/audit", {}],
    ];
    for (const [path, init] of guestRequests) {
      const response = await send("guest-session-id", path, init);
      expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(403);
    }

    // Owner still reaches the diagnostics surface (not 403).
    const ownerLogs = await send(OWNER_TOKEN, "/api/logs");
    expect(ownerLogs.status).not.toBe(403);
    const ownerAudit = await send(OWNER_TOKEN, "/api/security/audit");
    expect(ownerAudit.status).not.toBe(403);
  } finally {
    await server?.close();
    _resetAgentHostBridge();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

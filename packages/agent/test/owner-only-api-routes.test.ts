/**
 * A paired USER session (a guest device) passes the shared API gate. Wallet
 * writes, config and character writes and the memory store are owner-only:
 * real API server, SQLite runtime, host bridge that maps the guest bearer to
 * USER.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntime, createMessageMemory, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { startApiServer } from "../src/api/server.ts";
import {
  _resetAgentHostBridge,
  setAgentHostBridge,
} from "../src/runtime/host-bridge.ts";

const OWNER_TOKEN = "owner-static-token-0123456789abcdef0123456789";

it("refuses owner-only writes and memory reads to a paired USER session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-owner-only-"));
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_PERSIST_CONFIG_PATH: join(directory, "config.json"),
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: OWNER_TOKEN,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  // Setup is complete: onboarding must not reopen to a guest.
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
    character: { name: "OwnerOnly", bio: [], settings: {} },
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
    const roomId = randomUUID() as UUID;
    const ownerId = randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId: ownerId,
      roomId,
      worldId: randomUUID() as UUID,
      source: "client_chat",
      userName: "owner",
      name: "Owner",
    } as never);
    const memoryId = randomUUID() as UUID;
    await runtime.createMemory(
      createMessageMemory({
        id: memoryId,
        entityId: ownerId,
        agentId: runtime.agentId,
        roomId,
        content: { text: "owner private note", source: "client_chat" },
      }),
      "messages",
    );

    const guestRequests: [string, RequestInit][] = [
      ["/api/memories/browse?q=private", {}],
      ["/api/context/quick?q=private", {}],
      ["/api/context/quick/?q=private", {}],
      [`/api/memories/${memoryId}`, { method: "DELETE" }],
      [`/api/files/${"a".repeat(64)}.png`, { method: "DELETE" }],
      [
        "/api/agent/export",
        {
          method: "POST",
          body: JSON.stringify({ password: "guest-pass-123" }),
        },
      ],
      ["/api/snapshot", { method: "POST" }],
      ["/api/restore", { method: "POST", body: "{}" }],
      ["/api/backups", {}],
      ["/api/agent/import", { method: "POST", body: "{}" }],
      ["/api/agent/reset", { method: "POST" }],
      ["/api/agent/stop", { method: "POST" }],
      ["/api/restart", { method: "POST" }],
      [
        "/api/agent/autonomy",
        { method: "POST", body: JSON.stringify({ enabled: true }) },
      ],
      [
        "/api/permissions/shell",
        { method: "PUT", body: JSON.stringify({ enabled: true }) },
      ],
      [
        "/api/permissions/trade-mode",
        { method: "PUT", body: JSON.stringify({ mode: "agent-auto" }) },
      ],
      [
        "/api/connectors",
        {
          method: "POST",
          body: JSON.stringify({ name: "discord", config: {} }),
        },
      ],
      [
        "/api/provider/switch",
        { method: "POST", body: JSON.stringify({ provider: "openai" }) },
      ],
      [
        "/api/config",
        {
          method: "PUT",
          body: JSON.stringify({
            env: { vars: { OPENAI_BASE_URL: "https://example.invalid/v1" } },
          }),
        },
      ],
      [
        "/api/character",
        {
          method: "PUT",
          body: JSON.stringify({ system: "Changed by guest." }),
        },
      ],
      [
        "/api/wallet/browser-sign-message",
        { method: "POST", body: JSON.stringify({ message: "hello" }) },
      ],
      [
        "/api/first-run",
        {
          method: "POST",
          body: JSON.stringify({ name: "Guest", systemPrompt: "Guest set." }),
        },
      ],
      [
        "/api/workbench/vfs/projects",
        { method: "POST", body: JSON.stringify({ name: "guest-project" }) },
      ],
      [
        "/api/workbench/vfs/projects/guest-project/load-plugin",
        { method: "POST", body: JSON.stringify({ entry: "p.mjs" }) },
      ],
      [
        "/api/plugins/load-from-directory",
        { method: "POST", body: JSON.stringify({ directory: "/tmp/p" }) },
      ],
      [
        "/api/plugins/unload-from-directory",
        { method: "POST", body: JSON.stringify({ pluginName: "sql" }) },
      ],
      ["/api/custom-actions", {}],
      [
        "/api/custom-actions",
        {
          method: "POST",
          body: JSON.stringify({
            name: "GUEST_ACTION",
            handler: { type: "http" },
          }),
        },
      ],
      ["/api/logs", {}],
      ["/api/logs", { method: "DELETE" }],
      ["/api/agent/events", {}],
      ["/api/security/audit", {}],
      [
        "/api/database/query",
        { method: "POST", body: JSON.stringify({ sql: "SELECT 1" }) },
      ],
      ["/api/database/config", {}],
      [
        "/api/capability-router/connect",
        {
          method: "POST",
          body: JSON.stringify({
            endpoint: { baseUrl: "https://example.invalid" },
          }),
        },
      ],
      [
        "/api/sandbox/exec",
        { method: "POST", body: JSON.stringify({ command: "id" }) },
      ],
      [
        "/api/coding-agents/spawn",
        { method: "POST", body: JSON.stringify({ task: "echo hi" }) },
      ],
      ["/api/browser-workspace", {}],
      ["/api/imessage/messages", {}],
      [
        "/api/imessage/messages",
        {
          method: "POST",
          body: JSON.stringify({ to: "+15550002", text: "hi" }),
        },
      ],
      [
        "/api/cloud/x/posts",
        { method: "POST", body: JSON.stringify({ text: "hi" }) },
      ],
      ["/api/workflow/workflows", {}],
      [
        "/api/setup/telegram/start",
        { method: "POST", body: JSON.stringify({ botToken: "1:x" }) },
      ],
      [
        "/api/meetings",
        {
          method: "POST",
          body: JSON.stringify({ url: "https://example.invalid" }),
        },
      ],
      ["/api/github/token", { method: "DELETE" }],
      ["/api/lifeops/scheduled-tasks", {}],
      ["/api/voice/profiles", {}],
      ["/api/notes/state", {}],
      ["/assistant/autonomy/enable", { method: "POST" }],
    ];
    for (const [path, init] of guestRequests) {
      const response = await send("guest-session-id", path, init);
      expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(403);
    }
    expect(await runtime.getMemoryById(memoryId)).not.toBeNull();
    expect(process.env.OPENAI_BASE_URL).not.toBe("https://example.invalid/v1");
    expect(runtime.character.system).not.toBe("Changed by guest.");

    // The connector OAuth callback is authenticated by its state/code, so the
    // owner gate leaves it to the callback handler.
    const callback = await send(
      "guest-session-id",
      "/api/connectors/google/oauth/callback",
      { method: "POST", body: JSON.stringify({ code: "c", state: "s" }) },
    );
    expect(callback.status).not.toBe(403);

    // Reads of settings stay open to the session; the owner keeps every route.
    expect((await send("guest-session-id", "/api/config")).status).toBe(200);
    const ownerBrowse = await send(
      OWNER_TOKEN,
      "/api/memories/browse?q=private",
    );
    expect(ownerBrowse.status).toBe(200);
    const ownerCharacter = await send(OWNER_TOKEN, "/api/character", {
      method: "PUT",
      body: JSON.stringify({ system: "Set by the owner." }),
    });
    expect(ownerCharacter.status).toBe(200);
    // The wallet gate passes the owner through to the wallet routes.
    const ownerSign = await send(
      OWNER_TOKEN,
      "/api/wallet/browser-sign-message",
      {
        method: "POST",
        body: JSON.stringify({ message: "hello" }),
      },
    );
    expect(ownerSign.status).not.toBe(403);
  } finally {
    await server?.close();
    await runtime.close();
    _resetAgentHostBridge();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 300_000);

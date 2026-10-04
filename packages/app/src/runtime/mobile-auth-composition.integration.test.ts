import { test } from "bun:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { StdioBridgeStreamSink } from "../../../../plugins/plugin-native-inference/src/shared/stdio-bridge.ts";

// Real DB + production native dispatcher/kernel: no route/session mocks or provider calls.
test("mobile host composes revocable owner sessions through buffered and streaming native dispatch", async () => {
  const root = path.resolve(import.meta.dir, "../../../..");
  const environment = { ...process.env };
  try {
    const os = await import("node:os");
    const temp = fs.mkdtempSync(
      path.join(os.tmpdir(), "mobile-auth-composition-"),
    );
    process.env.ELIZA_STATE_DIR = temp;
    process.env.ELIZA_CONFIG_PATH = path.join(temp, "eliza.json");
    process.env.ELIZA_API_TOKEN = "synthetic-composition-root-token";
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DISABLE_VAULT_PROFILE_RESOLVER = "1";
    process.env.ELIZA_AGENT_ORCHESTRATOR = "0";
    const { installMobileAuthHostBridge } = await import(
      path.join(
        root,
        "packages/app/src/runtime/install-mobile-auth-host-bridge.ts",
      )
    );
    installMobileAuthHostBridge();
    const { createDatabaseAdapter, plugin: sqlPlugin } = await import(
      "@elizaos/plugin-sql"
    );
    const adapter = createDatabaseAdapter(
      { dataDir: path.join(temp, "db") },
      "00000000-0000-0000-0000-000000000001",
    );
    await adapter.initialize();
    assert.ok(
      adapter.runPluginMigrations,
      "SQL adapter must support plugin migrations",
    );
    await adapter.runPluginMigrations([sqlPlugin]);
    const { AgentRuntime, createCharacter } = await import("@elizaos/core");
    const runtime = new AgentRuntime({
      character: createCharacter({ name: "CompositionAuth" }),
      adapter,
    });
    const { startApiServer } = await import(
      path.join(root, "packages/agent/src/api/server.ts")
    );
    const { dispatchApiRoute } = await import(
      path.join(root, "packages/agent/src/api/in-process-api.ts")
    );
    const { dispatchBufferedRequest, dispatchStreamingRequest } = await import(
      path.join(root, "plugins/plugin-native-inference/src/android/dispatch.ts")
    );
    let server = await startApiServer({
      runtime,
      port: 0,
      skipListen: true,
      skipDeferredStartupWork: true,
    });
    async function request(route: string, token?: string, body?: unknown) {
      const response = await dispatchBufferedRequest(
        runtime,
        dispatchApiRoute,
        {
          path: route,
          method: body === undefined ? "GET" : "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { fullApiKernel: true } as never,
      );
      return {
        status: response.status,
        body: JSON.parse(Buffer.from(response.bodyBase64, "base64").toString()),
      };
    }
    try {
      const status = await request(
        "/api/auth/status",
        process.env.ELIZA_API_TOKEN,
      );
      assert.equal(status.status, 200);
      const code = await request(
        "/api/auth/pair-code",
        process.env.ELIZA_API_TOKEN,
      );
      assert.equal(code.status, 200);
      const paired = await request(
        "/api/auth/pair",
        process.env.ELIZA_API_TOKEN,
        { code: code.body.code, instanceId: status.body.instanceId },
      );
      assert.equal(paired.status, 200);
      assert.equal(paired.body.access, "owner");
      assert.equal(paired.body.instanceId, status.body.instanceId);
      assert.notEqual(paired.body.token, process.env.ELIZA_API_TOKEN);
      const replay = await request(
        "/api/auth/pair",
        process.env.ELIZA_API_TOKEN,
        { code: code.body.code, instanceId: status.body.instanceId },
      );
      assert.ok([400, 401, 403].includes(replay.status));
      const me = await request("/api/auth/me", paired.body.token);
      assert.equal(me.status, 200);
      assert.equal(me.body.identity.kind, "owner");
      assert.equal(me.body.access.role, "OWNER");
      assert.equal(me.body.session.id, paired.body.token);
      assert.equal(me.body.identity.id, paired.body.identityId);
      const denied = await request("/api/auth/me", "synthetic-invalid-token");
      assert.ok([401, 403].includes(denied.status));
      const missing = await request("/api/conversations");
      assert.ok([401, 403].includes(missing.status));
      assert.ok(
        [401, 403].includes(
          (
            await request(
              "/api/trajectories?limit=1",
              "synthetic-invalid-token",
            )
          ).status,
        ),
      );
      async function streamed(token: string) {
        let status = 0;
        const chunks: string[] = [];
        await dispatchStreamingRequest(
          runtime,
          dispatchApiRoute,
          {
            path: "/api/agents",
            method: "GET",
            headers: { Authorization: `Bearer ${token}` },
          },
          {
            emitResponse: (
              response: Parameters<StdioBridgeStreamSink["emitResponse"]>[0],
            ) => {
              status = response.status;
            },
            emitChunk: (chunk: string) => chunks.push(chunk),
          },
          { fullApiKernel: true } as never,
        );
        return {
          status,
          body: Buffer.concat(
            chunks.map((value) => Buffer.from(value, "base64")),
          ).toString(),
        };
      }
      assert.equal((await streamed(paired.body.token)).status, 200);
      assert.ok(
        [401, 403].includes((await streamed("synthetic-invalid-token")).status),
      );
      const agents = await request("/api/agents", paired.body.token);
      assert.equal(agents.status, 200);
      assert.equal(agents.body.agents.length, 1);
      const agentId = agents.body.agents[0].id;
      const rejected = await request(
        "/api/conversations",
        "synthetic-invalid-token",
      );
      assert.ok([401, 403].includes(rejected.status));
      const notifications = await request(
        "/api/notifications",
        "synthetic-invalid-token",
      );
      assert.ok([401, 403].includes(notifications.status));
      await server.close();
      server = await startApiServer({
        runtime,
        port: 0,
        skipListen: true,
        skipDeferredStartupWork: true,
      });
      const restored = await request("/api/auth/me", paired.body.token);
      assert.equal(restored.status, 200);
      assert.equal(restored.body.identity.id, paired.body.identityId);
      assert.equal(restored.body.session.id, paired.body.token);
      assert.equal(
        (await request("/api/agents", paired.body.token)).body.agents[0].id,
        agentId,
      );
      const revoked = await request(
        `/api/auth/sessions/${paired.body.token}/revoke`,
        paired.body.token,
        {},
      );
      assert.equal(revoked.status, 200);
      assert.ok(
        [401, 403].includes(
          (await request("/api/auth/me", paired.body.token)).status,
        ),
      );
      console.log(
        "PASS real owner session, kernel restart persistence, agent identity, revocation, invalid protected routes; actual Android buffered dispatch → full agent kernel → app owner pairing/session; invalid bearer denied",
      );
    } finally {
      await server.close();
      await adapter.close();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    const { _resetAgentHostBridge } = await import(
      "@elizaos/agent/runtime/host-bridge"
    );
    _resetAgentHostBridge();
  }
}, 90000);

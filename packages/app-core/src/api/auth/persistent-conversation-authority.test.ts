/**
 * Exercises session-to-scope composition through the real agent HTTP kernel and
 * SQLite. The fixture enrolls identities directly; it does not replace pairing
 * qualification or prove protected model/SSE dispatch.
 */
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConversationExternalEntityId } from "@elizaos/agent/api/conversation-routes";
import { startApiServer } from "@elizaos/agent/api/server";
import {
  defaultAgentHostBridge,
  getAgentHostBridge,
  setAgentHostBridge,
} from "@elizaos/agent/runtime/host-bridge";
import {
  AgentRuntime,
  createCharacter,
  stringToUuid,
  validateUuid,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { authStoreForRuntime } from "../../services/auth-store";
import { createPersistentConversationAuthority } from "./persistent-conversation-authority";
import { createMachineSession } from "./sessions";

it("uses persistent sessions and current memberships without loopback or static-token fallback", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-authority-http-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  const staticToken = "fixture-static-token-without-persistent-session";
  vi.stubEnv("ELIZA_API_TOKEN", staticToken);
  const bridge = getAgentHostBridge();
  const agentId = stringToUuid("authority-http-agent");
  const adapter = SQLiteDatabaseAdapter.create(
    join(directory, "agent.sqlite"),
    agentId,
  );
  await adapter.initialize();
  const runtime = new AgentRuntime({
    agentId,
    adapter,
    character: createCharacter({ name: "Authority HTTP" }),
    plugins: [],
    logLevel: "fatal",
    enableAutonomy: false,
  });
  const store = authStoreForRuntime(runtime);
  if (!store) throw new Error("Authentication storage missing");
  const authority = createPersistentConversationAuthority({
    runtime,
    config: {},
    allowedOrigins: ["http://localhost"],
  });
  let api: Awaited<ReturnType<typeof startApiServer>> | undefined;
  let server: Server | undefined;
  try {
    await adapter.createAgents([{ id: agentId, name: "Authority HTTP" }]);
    for (const id of ["first-device", "second-device"])
      await store.createIdentity({
        id,
        kind: "machine",
        displayName: id,
        createdAt: Date.now(),
      });
    const first = (
      await createMachineSession(store, {
        identityId: "first-device",
        scopes: [],
      })
    ).session;
    const second = (
      await createMachineSession(store, {
        identityId: "second-device",
        scopes: [],
      })
    ).session;
    setAgentHostBridge({
      ...defaultAgentHostBridge,
      resolveHttpRequestAuthorization:
        authority.resolveHttpRequestAuthorization,
    });
    api = await startApiServer({
      runtime,
      hostConfig: {},
      skipListen: true,
      skipDeferredStartupWork: true,
      configureServer: (value) => {
        server = value;
      },
      hostAdmission: (req, boundary) => {
        // This test exposes only collection creation/listing; broader method and
        // stream policies remain the measured host's separate acceptance gate.
        if (
          boundary !== "request" ||
          req.url !== "/api/conversations" ||
          !["GET", "POST"].includes(req.method ?? "")
        )
          return false;
        return authority.admit(req);
      },
    });
    const listener = server;
    if (!listener) throw new Error("Kernel listener missing");
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();
    if (!address || typeof address === "string")
      throw new Error("Kernel address unavailable");
    const url = `http://127.0.0.1:${address.port}/api/conversations`;
    const headers = (token: string) => ({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    });
    expect((await fetch(url)).status).toBe(403);
    expect(
      (await fetch(url, { headers: headers("not-a-session") })).status,
    ).toBe(403);
    expect((await fetch(url, { headers: headers(staticToken) })).status).toBe(
      403,
    );
    expect(
      (
        await fetch(url, {
          headers: {
            ...headers(first.id),
            Origin: "https://unapproved.example",
          },
        })
      ).status,
    ).toBe(403);
    const created = await fetch(url, {
      method: "POST",
      headers: headers(first.id),
      body: JSON.stringify({ title: "First device conversation" }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const data = z
      .object({
        conversation: z.object({ id: z.string(), roomId: z.string() }),
      })
      .parse(await created.json());
    expect(
      await (await fetch(url, { headers: headers(first.id) })).json(),
    ).toMatchObject({ conversations: [{ id: data.conversation.id }] });
    expect(
      await (await fetch(url, { headers: headers(second.id) })).json(),
    ).toEqual({ conversations: [] });
    const roomId = validateUuid(data.conversation.roomId);
    if (!roomId) throw new Error("Conversation room identity invalid");
    await adapter.deleteParticipants([
      {
        entityId: resolveConversationExternalEntityId("first-device"),
        roomId,
      },
    ]);
    expect(
      await (await fetch(url, { headers: headers(first.id) })).json(),
    ).toEqual({ conversations: [] });
    await store.revokeSession(first.id, Date.now());
    expect((await fetch(url, { headers: headers(first.id) })).status).toBe(403);
    authority.revoke();
    expect((await fetch(url, { headers: headers(second.id) })).status).toBe(
      403,
    );
  } finally {
    authority.revoke();
    const listener = server;
    if (listener) {
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
    if (api) await api.close();
    setAgentHostBridge(bridge);
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

/**
 * Drives conversation reads through real HTTP, AgentRuntime and reopened SQLite.
 * The harness supplies verified grants; authentication and grant issuance are
 * separate contracts. No runtime, query, or route implementation is mocked.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  MemoryType,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import {
  readJsonBody,
  sendJson,
  sendJsonError,
} from "@elizaos/shared/api/http-helpers";
import { expect, it } from "vitest";
import {
  type ConversationRouteState,
  handleConversationRoutes,
} from "./conversation-routes";
import { bindRequiredHttpAccessContext } from "./http-access-context";

it("scopes lists, ranked search and paginated messages before and after reopen", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eliza-scope-route-"));
  const agentId = stringToUuid("scope-route-agent");
  const actor = stringToUuid("scope-route-owner");
  const other = stringToUuid("scope-route-other");
  const allowed = stringToUuid("scope-route-allowed");
  const forbidden = stringToUuid("scope-route-forbidden");
  const world = stringToUuid("scope-route-world");
  const openRuntime = async () => {
    const adapter = SQLiteDatabaseAdapter.create(
      join(directory, "agent.sqlite"),
      agentId,
    );
    await adapter.initialize();
    return {
      adapter,
      runtime: new AgentRuntime({
        agentId,
        character: createCharacter({ name: "Scoped route" }),
        adapter,
        plugins: [],
        logLevel: "fatal",
        enableAutonomy: false,
      }),
    };
  };
  let opened = await openRuntime();
  let rooms: UUID[] = [allowed];
  const state: ConversationRouteState = {
    runtime: opened.runtime,
    config: {},
    agentName: "Scoped route",
    adminEntityId: actor,
    chatUserId: actor,
    logBuffer: [],
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
    conversations: new Map(
      [allowed, forbidden].map((roomId) => [
        roomId,
        {
          id: roomId,
          roomId,
          title: roomId === allowed ? "Allowed" : "Forbidden",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
        },
      ]),
    ),
  };
  const server = createServer(async (req, res) => {
    try {
      bindRequiredHttpAccessContext(req, {
        requesterEntityId: actor,
        role: "OWNER",
        isOwner: true,
        authorizedRoomIds: rooms,
      });
      const handled = await handleConversationRoutes({
        req,
        res,
        method: req.method ?? "",
        pathname: new URL(req.url ?? "", "http://localhost").pathname,
        state,
        callerAuthorization: {
          ok: true,
          role: "OWNER",
          identityId: "test-owner",
        },
        json: sendJson,
        error: sendJsonError,
        readJsonBody,
      });
      if (!handled) sendJsonError(res, "Not found", 404);
    } catch (error) {
      // error-policy:J1 The real HTTP test boundary exposes failures as test-visible errors.
      sendJsonError(
        res,
        error instanceof Error ? error.message : String(error),
        500,
      );
    }
  });
  try {
    await opened.adapter.createAgents([{ id: agentId, name: "Scoped route" }]);
    await opened.adapter.createEntities([
      { id: actor, agentId, names: ["Owner"] },
      { id: other, agentId, names: ["Other"] },
    ]);
    await opened.adapter.createWorlds([{ id: world, agentId, name: "World" }]);
    await opened.adapter.createRooms(
      [allowed, forbidden].map((id) => ({
        id,
        agentId,
        worldId: world,
        type: ChannelType.API,
        source: "test",
      })),
    );
    for (const [key, roomId, entityId, scope, createdAt] of [
      ["allowed", allowed, actor, "room", 1000],
      ["foreign-private", allowed, other, "user-private", 2000],
      ["forbidden", forbidden, actor, "room", 3000],
    ] as const) {
      await opened.adapter.createMemories([
        {
          memory: {
            id: stringToUuid(key),
            agentId,
            roomId,
            entityId,
            createdAt,
            content: { text: `needle ${key}`, source: "client_chat" },
            metadata: { type: MemoryType.MESSAGE, scope },
          },
          tableName: "messages",
        },
      ]);
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP listener unavailable");
    const base = `http://127.0.0.1:${address.port}`;
    for (const reopen of [false, true]) {
      if (reopen) {
        await opened.runtime.close();
        opened = await openRuntime();
        state.runtime = opened.runtime;
      }
      const listing = await fetch(`${base}/api/conversations`);
      expect(listing.status).toBe(200);
      expect(await listing.json()).toMatchObject({
        conversations: [{ id: allowed }],
      });
      const search = await fetch(
        `${base}/api/conversations/messages/search?q=needle&limit=1`,
      );
      expect(search.status).toBe(200);
      expect(await search.json()).toMatchObject({
        results: [{ conversationId: allowed, text: "needle allowed" }],
        count: 1,
      });
      for (const query of [
        "",
        "?before=4000&limit=1",
        `?around=${stringToUuid("foreign-private")}`,
      ]) {
        const response = await fetch(
          `${base}/api/conversations/${allowed}/messages${query}`,
        );
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain("needle allowed");
        expect(body).not.toContain("needle foreign-private");
        expect(body).not.toContain("needle forbidden");
      }
      expect(
        (await fetch(`${base}/api/conversations/${forbidden}/messages`)).status,
      ).toBe(404);
    }
    rooms = [];
    expect(await (await fetch(`${base}/api/conversations`)).json()).toEqual({
      conversations: [],
    });
    expect(
      await (
        await fetch(`${base}/api/conversations/messages/search?q=needle`)
      ).json(),
    ).toEqual({ results: [], count: 0 });
    expect(
      (await fetch(`${base}/api/conversations/${allowed}/messages`)).status,
    ).toBe(404);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await opened.runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

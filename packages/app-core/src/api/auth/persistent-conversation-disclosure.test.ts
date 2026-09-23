/**
 * Exercises protected HTTP delivery with real persistent sessions, SQLite room
 * membership, and sockets. Revocation occurs after the client receives the first
 * chunk; subsequent private bytes must never reach that client.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSse, writeSse } from "@elizaos/agent/api/chat-routes";
import { resolveConversationExternalEntityId } from "@elizaos/agent/api/conversation-routes";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  stringToUuid,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import {
  bindRequiredHttpDelivery,
  endRequiredHttpDelivery,
  type HttpDeliveryOutcome,
} from "@elizaos/shared/api/required-http-delivery";
import { expect, it } from "vitest";
import { authStoreForRuntime } from "../../services/auth-store";
import { createPersistentConversationAuthority } from "./persistent-conversation-authority";
import { createMachineSession } from "./sessions";

it.each(["session", "membership", "host", "none"] as const)(
  "checks %s revocation before each protected delivery",
  async (revocation) => {
    const directory = await mkdtemp(join(tmpdir(), "eliza-disclosure-http-"));
    const agentId = stringToUuid("disclosure-agent");
    const entityId = resolveConversationExternalEntityId("disclosure-device");
    const roomId = stringToUuid("disclosure-room");
    const adapter = SQLiteDatabaseAdapter.create(
      join(directory, "agent.sqlite"),
      agentId,
    );
    await adapter.initialize();
    const runtime = new AgentRuntime({
      agentId,
      adapter,
      character: createCharacter({ name: "Disclosure" }),
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
    const continueDelivery = Promise.withResolvers<void>();
    const handlerFinished = Promise.withResolvers<void>();
    const failures: Error[] = [];
    const outcomes: HttpDeliveryOutcome[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (!(await authority.admit(request))) {
          response.writeHead(403).end();
          return;
        }
        const disclosure = authority.captureDisclosure(request);
        let first = true;
        const delivery = bindRequiredHttpDelivery(response, {
          maxPendingBytes: 4096,
          deliver: async (dispatch) => {
            if (!first) await continueDelivery.promise;
            first = false;
            return disclosure.deliver(dispatch);
          },
        });
        initSse(response);
        writeSse(response, { text: "first permitted" });
        writeSse(response, { text: "second permitted only while authorized" });
        endRequiredHttpDelivery(response);
        outcomes.push(await delivery.completed);
      })()
        .catch((error: Error) => {
          // error-policy:J1 Surface handler failure through both the socket and test result.
          failures.push(error);
          response.destroy(error);
        })
        .finally(() => handlerFinished.resolve());
    });
    try {
      await adapter.createAgents([{ id: agentId, name: "Disclosure" }]);
      await adapter.createEntities([
        { id: agentId, agentId, names: ["Agent"] },
        { id: entityId, agentId, names: ["Paired device"] },
      ]);
      await adapter.createRooms([
        { id: roomId, agentId, type: ChannelType.API, source: "test" },
      ]);
      await adapter.createRoomParticipants([agentId, entityId], roomId);
      await store.createIdentity({
        id: "disclosure-device",
        kind: "machine",
        displayName: "Paired device",
        createdAt: Date.now(),
      });
      const { session } = await createMachineSession(store, {
        identityId: "disclosure-device",
        scopes: [],
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Listener unavailable");
      const response = await fetch(`http://127.0.0.1:${address.port}/`, {
        headers: { Authorization: `Bearer ${session.id}` },
      });
      expect(response.status).toBe(200);
      if (!response.body) throw new Error("Response body missing");
      const reader = response.body.getReader();
      const firstChunk = await reader.read();
      expect(firstChunk.done).toBe(false);
      const decoder = new TextDecoder();
      let body = decoder.decode(firstChunk.value, { stream: true });
      expect(body).toBe('data: {"text":"first permitted"}\n\n');
      if (revocation === "session")
        await store.revokeSession(session.id, Date.now());
      if (revocation === "membership")
        await adapter.deleteParticipants([{ entityId, roomId }]);
      if (revocation === "host") authority.revoke();
      continueDelivery.resolve();
      let interrupted = false;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } catch (error) {
        // error-policy:J1 Revocation is an interrupted HTTP stream, never a successful prefix.
        expect(error).toBeInstanceOf(Error);
        interrupted = true;
      } finally {
        reader.releaseLock();
      }
      await handlerFinished.promise;
      expect(failures).toEqual([]);
      expect(outcomes).toEqual([
        { kind: revocation === "none" ? "complete" : "denied" },
      ]);
      expect(interrupted).toBe(revocation !== "none");
      expect(body).toBe(
        revocation === "none"
          ? 'data: {"text":"first permitted"}\n\ndata: {"text":"second permitted only while authorized"}\n\n'
          : 'data: {"text":"first permitted"}\n\n',
      );
    } finally {
      continueDelivery.resolve();
      authority.revoke();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);

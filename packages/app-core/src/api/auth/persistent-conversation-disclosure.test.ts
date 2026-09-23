/**
 * Exercises protected HTTP delivery with real persistent sessions, SQLite room
 * membership, and sockets. Revocation occurs after the client receives the first
 * chunk; subsequent private bytes must never reach that client.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConversationExternalEntityId } from "@elizaos/agent/api/conversation-routes";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  stringToUuid,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
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
    const deliveries: boolean[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        if (!(await authority.admit(request))) {
          response.writeHead(403).end();
          return;
        }
        const disclosure = authority.captureDisclosure(request);
        deliveries.push(
          await disclosure.deliver(() => {
            response.writeHead(200, { "Content-Type": "text/plain" });
            response.write("first permitted\n");
          }),
        );
        await continueDelivery.promise;
        deliveries.push(
          await disclosure.deliver(() => {
            response.write("second permitted only while authorized\n");
          }),
        );
        // The terminal control marker contains no protected response data.
        response.end(deliveries[1] ? "complete\n" : "revoked\n");
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
      if (revocation === "session")
        await store.revokeSession(session.id, Date.now());
      if (revocation === "membership")
        await adapter.deleteParticipants([{ entityId, roomId }]);
      if (revocation === "host") authority.revoke();
      continueDelivery.resolve();
      const body = await response.text();
      await handlerFinished.promise;
      expect(failures).toEqual([]);
      expect(deliveries).toEqual([true, revocation === "none"]);
      expect(body).toBe(
        revocation === "none"
          ? "first permitted\nsecond permitted only while authorized\ncomplete\n"
          : "first permitted\nrevoked\n",
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

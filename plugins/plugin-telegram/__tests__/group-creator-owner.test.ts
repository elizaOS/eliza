/**
 * Anyone can create a Telegram group and add the bot. Without a configured
 * owner, the group's creator must not resolve as the agent's OWNER. Real
 * world creation (`handleNewChat`), real core role resolution and real sender
 * auth; the runtime stores worlds in memory.
 */
import { createUniqueUuid, hasRoleAccess } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { resolveTelegramRuntimeEntityId } from "../src/identity";
import { resolveTelegramSenderAuth } from "../src/sender-auth";
import { TelegramService } from "../src/service";

const CREATOR_ID = 777000111;
const CHAT = { id: -100555, type: "supergroup", title: "a stranger's group" };

function memoryRuntime() {
  const worlds = new Map<string, { metadata?: Record<string, unknown> }>();
  const records = new Map<string, unknown>();
  const runtime = {
    agentId: "11111111-2222-3333-4444-555555555555",
    character: { name: "agent", settings: {} },
    getSetting: () => undefined,
    getWorld: async (id: string) => worlds.get(id) ?? null,
    ensureWorldExists: async (world: { id: string }) => {
      if (!worlds.has(world.id)) worlds.set(world.id, world);
    },
    ensureRoomExists: async (room: { id: string }) => {
      records.set(room.id, room);
    },
    getRoom: async (id: string) => records.get(id) ?? null,
    getEntityById: async (id: string) => records.get(id) ?? null,
    createEntity: async (entity: { id: string }) => {
      records.set(entity.id, entity);
      return true;
    },
    createEntities: async (entities: Array<{ id: string }>) => {
      for (const entity of entities) records.set(entity.id, entity);
      return true;
    },
    updateEntity: async (entity: { id: string }) => {
      records.set(entity.id, entity);
    },
    ensureConnection: async () => {},
    ensureConnections: async () => {},
    getRelationships: async () => [],
    emitEvent: async () => {},
    getService: () => null,
    reportError: () => {},
    logger: { info() {}, warn() {}, debug() {}, error() {} },
  };
  return { runtime, worlds };
}

describe("Telegram group creator", () => {
  it.each(["default", "work"])(
    "is not the agent's OWNER on account %s",
    async (accountId) => {
      const { runtime, worlds } = memoryRuntime();
      const admins = async () => [
        { status: "creator", user: { id: CREATOR_ID, first_name: "Mallory" } },
      ];
      const service = Object.create(TelegramService.prototype);
      Object.assign(service, {
        runtime,
        defaultAccountId: accountId,
        knownChats: new Map(),
        syncedEntityIds: new Set(),
        accountStates: new Map(),
        getAccountState: () => ({
          bot: {
            telegram: { getChatAdministrators: admins },
            botInfo: { username: "agent_bot" },
          },
        }),
      });
      const ctx = {
        chat: CHAT,
        from: { id: CREATOR_ID, first_name: "Mallory", username: "mallory" },
        message: { message_id: 1, text: "run a shell command", chat: CHAT },
        getChatAdministrators: admins,
      };
      await service.handleNewChat(ctx, accountId);

      const entityId = await resolveTelegramRuntimeEntityId(
        runtime as never,
        accountId,
        String(CREATOR_ID),
      );
      const roomKey =
        accountId === "default" ? String(CHAT.id) : `${accountId}:${CHAT.id}`;
      const message = {
        id: createUniqueUuid(runtime as never, "message-1"),
        entityId,
        agentId: runtime.agentId,
        roomId: createUniqueUuid(runtime as never, roomKey),
        content: { text: "run a shell command", source: "telegram" },
        metadata: {
          source: "telegram",
          fromId: String(CREATOR_ID),
          telegram: { userId: String(CREATOR_ID), id: String(CREATOR_ID) },
        },
      };

      const [world] = [...worlds.values()];
      expect(world?.metadata?.ownership).toBeUndefined();
      expect(
        await hasRoleAccess(runtime as never, message as never, "OWNER"),
      ).toBe(false);
      expect(
        (
          await resolveTelegramSenderAuth(
            ctx as never,
            runtime as never,
            accountId,
          )
        ).isAuthorized,
      ).toBe(false);
    },
  );
});

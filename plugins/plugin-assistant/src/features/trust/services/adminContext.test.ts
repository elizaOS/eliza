/** resolveAdminContext against a real runtime's world, room and role state. */
import {
  type AgentRuntime,
  ChannelType,
  createCharacter,
  hasAdminAccess,
  type Memory,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAdminContext } from "./adminContext.ts";

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

async function createRuntime(): Promise<AgentRuntime> {
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "TrustAdminContext" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtimes.push(runtime);
  await runtime.initialize({ skipMigrations: true });
  return runtime;
}

/**
 * Seeds a world and room the way the app's conversation routes do: the world
 * records its owner in `ownership.ownerId`. Extra world metadata (stored roles
 * and their sources) is merged in when a case needs it.
 */
async function seedRoom(
  runtime: AgentRuntime,
  options: {
    type: ChannelType;
    source: string;
    ownerId: UUID;
    metadata?: Record<string, unknown>;
  },
): Promise<UUID> {
  const worldId = crypto.randomUUID() as UUID;
  const roomId = crypto.randomUUID() as UUID;
  await runtime.createWorld({
    id: worldId,
    agentId: runtime.agentId,
    name: "Owner world",
    metadata: { ownership: { ownerId: options.ownerId }, ...options.metadata },
  });
  await runtime.createRoom({
    id: roomId,
    agentId: runtime.agentId,
    worldId,
    name: "Owner room",
    source: options.source,
    type: options.type,
  });
  return roomId;
}

function messageFrom(
  runtime: AgentRuntime,
  entityId: UUID,
  roomId: UUID,
  source: string,
): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId,
    agentId: runtime.agentId,
    roomId,
    content: { text: "I need to update the OpenAI API key", source },
  };
}

describe("resolveAdminContext", () => {
  it("treats the owner of the app's direct chat as admin context", async () => {
    const runtime = await createRuntime();
    const ownerId = crypto.randomUUID() as UUID;
    const roomId = await seedRoom(runtime, {
      type: ChannelType.DM,
      source: "client_chat",
      ownerId,
    });
    const message = messageFrom(runtime, ownerId, roomId, "client_chat");

    // The securityStatus provider's ADMIN role gate resolves roles this way.
    expect(await hasAdminAccess(runtime, message)).toBe(true);
    expect(await resolveAdminContext(runtime, message)).toBe(true);
  });

  it("treats the configured admin entity as admin context in a direct chat", async () => {
    const runtime = await createRuntime();
    const ownerId = crypto.randomUUID() as UUID;
    const roomId = await seedRoom(runtime, {
      type: ChannelType.DM,
      source: "client_chat",
      ownerId: crypto.randomUUID() as UUID,
    });
    runtime.setSetting("ELIZA_ADMIN_ENTITY_ID", ownerId);
    const message = messageFrom(runtime, ownerId, roomId, "client_chat");

    expect(await hasAdminAccess(runtime, message)).toBe(true);
    expect(await resolveAdminContext(runtime, message)).toBe(true);
  });

  it("treats a group world's recorded owner as admin context", async () => {
    const runtime = await createRuntime();
    const ownerId = crypto.randomUUID() as UUID;
    const roomId = await seedRoom(runtime, {
      type: ChannelType.GROUP,
      source: "discord",
      ownerId,
    });
    const message = messageFrom(runtime, ownerId, roomId, "discord");

    expect(await hasAdminAccess(runtime, message)).toBe(true);
    expect(await resolveAdminContext(runtime, message)).toBe(true);
  });

  it("keeps another sender in the owner's direct chat out of admin context", async () => {
    const runtime = await createRuntime();
    const ownerId = crypto.randomUUID() as UUID;
    const roomId = await seedRoom(runtime, {
      type: ChannelType.DM,
      source: "client_chat",
      ownerId,
    });
    const message = messageFrom(
      runtime,
      crypto.randomUUID() as UUID,
      roomId,
      "client_chat",
    );

    expect(await hasAdminAccess(runtime, message)).toBe(false);
    expect(await resolveAdminContext(runtime, message)).toBe(false);
  });

  it("follows core when it folds a stored OWNER role without a manual grant", async () => {
    const runtime = await createRuntime();
    const senderId = crypto.randomUUID() as UUID;
    const roomId = await seedRoom(runtime, {
      type: ChannelType.GROUP,
      source: "discord",
      ownerId: crypto.randomUUID() as UUID,
      metadata: { roles: { [senderId]: "OWNER" } },
    });
    const message = messageFrom(runtime, senderId, roomId, "discord");

    expect(await hasAdminAccess(runtime, message)).toBe(false);
    expect(await resolveAdminContext(runtime, message)).toBe(false);
  });

  it("follows core when a connector-admin role matches no whitelist entry", async () => {
    const runtime = await createRuntime();
    const senderId = crypto.randomUUID() as UUID;
    const roomId = await seedRoom(runtime, {
      type: ChannelType.GROUP,
      source: "discord",
      ownerId: crypto.randomUUID() as UUID,
      metadata: {
        roles: { [senderId]: "ADMIN" },
        roleSources: { [senderId]: "connector_admin" },
      },
    });
    const message = messageFrom(runtime, senderId, roomId, "discord");

    expect(await hasAdminAccess(runtime, message)).toBe(false);
    expect(await resolveAdminContext(runtime, message)).toBe(false);
  });
});

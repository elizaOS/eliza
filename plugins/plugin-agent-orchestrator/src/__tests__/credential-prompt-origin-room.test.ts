/**
 * Credential prompt routing through a PGlite-backed AgentRuntime. TASKS mints a
 * per-task GROUP room and stamps it on the session's `metadata.roomId`; the
 * user's connector chat is on `metadata.originRoomId` (actions/tasks.ts spawn
 * metadata). The credential prompt and its "received" follow-up must reach the
 * user's chat, the room the router's origin ladder targets.
 */

import { randomUUID } from "node:crypto";
import type { AgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { ChannelType } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  emitCredentialPrompt,
  emitCredentialResolved,
} from "../api/credential-prompt.js";
import { createRealTestRuntime } from "./real-runtime.js";

const SOURCE = "telegram";
const CHAT_ID = "-1001234567890";

describe("credential prompt room", () => {
  let runtime: AgentRuntime;
  let cleanup: (() => Promise<void>) | undefined;
  const attempted: Array<UUID | undefined> = [];
  const delivered: Array<{ roomId: UUID | undefined; chatId: string }> = [];
  let originRoomId: UUID;
  let taskRoomId: UUID;

  beforeAll(async () => {
    ({ runtime, cleanup } = await createRealTestRuntime({
      characterName: "CredentialPromptRoomTest",
    }));
    const worldId = randomUUID() as UUID;
    await runtime.ensureWorldExists({
      id: worldId,
      name: "Telegram",
      agentId: runtime.agentId,
      serverId: "telegram-server",
    } as Parameters<typeof runtime.ensureWorldExists>[0]);
    // The user's Telegram chat.
    originRoomId = randomUUID() as UUID;
    await runtime.createRoom({
      id: originRoomId,
      name: "telegram dm",
      source: SOURCE,
      type: ChannelType.DM,
      channelId: CHAT_ID,
      worldId,
    } as Room);
    // The room TASKS mints for the task (ensureDistinctTaskRoom): no chat id.
    taskRoomId = randomUUID() as UUID;
    await runtime.createRoom({
      id: taskRoomId,
      name: "build-landing-page",
      source: "orchestrator-task",
      type: ChannelType.GROUP,
      worldId,
    } as Room);
    // Resolves the chat from the target room's channelId, as plugin-telegram's
    // send handler does when it gets only a roomId.
    runtime.registerSendHandler(SOURCE, async (rt, target, content) => {
      attempted.push(target.roomId);
      const room = target.roomId ? await rt.getRoom(target.roomId) : null;
      if (!room?.channelId) {
        throw new Error(
          `Could not resolve Telegram chat ID from roomId ${target.roomId}`,
        );
      }
      delivered.push({ roomId: target.roomId, chatId: room.channelId });
      return {
        id: randomUUID() as UUID,
        entityId: rt.agentId,
        agentId: rt.agentId,
        roomId: target.roomId as UUID,
        content,
        createdAt: Date.now(),
      } satisfies Memory;
    });
  }, 60_000);

  afterAll(async () => {
    await cleanup?.();
  });

  /** Session metadata as TASKS stamps it on spawn with task rooms on. */
  const taskSessionMetadata = () => ({
    roomId: taskRoomId,
    originRoomId,
    taskRoomId,
    swarmRooms: [{ roomId: taskRoomId, roles: ["task"] }],
    source: SOURCE,
    label: "build-landing-page",
  });

  const reset = () => {
    attempted.length = 0;
    delivered.length = 0;
  };

  it("posts the credential request to the user's chat, not the task room", async () => {
    reset();
    const posted = await emitCredentialPrompt({
      runtime,
      metadata: taskSessionMetadata(),
      credentialKeys: ["VERCEL_TOKEN"],
      label: "build-landing-page",
      credentialScopeId: "scope-1",
      childSessionId: "session-1",
      expiresAt: Date.now() + 60_000,
    });
    expect(attempted).toEqual([originRoomId]);
    expect(posted).toBe(true);
    expect(delivered).toEqual([{ roomId: originRoomId, chatId: CHAT_ID }]);
  });

  it("posts the received follow-up to the user's chat, not the task room", async () => {
    reset();
    const posted = await emitCredentialResolved({
      runtime,
      metadata: taskSessionMetadata(),
      key: "VERCEL_TOKEN",
      label: "build-landing-page",
    });
    expect(attempted).toEqual([originRoomId]);
    expect(posted).toBe(true);
    expect(delivered).toEqual([{ roomId: originRoomId, chatId: CHAT_ID }]);
  });

  it("keeps posting to roomId when the session has no origin room", async () => {
    // ELIZA_ORCHESTRATOR_TASK_ROOMS=0, or a session from before task rooms.
    reset();
    const posted = await emitCredentialPrompt({
      runtime,
      metadata: { roomId: originRoomId, source: SOURCE },
      credentialKeys: ["VERCEL_TOKEN"],
    });
    expect(attempted).toEqual([originRoomId]);
    expect(posted).toBe(true);
  });
});

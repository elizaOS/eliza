/** Real runtime: an owner reply resolves the escalation even when newer room traffic follows it. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentRuntime, ChannelType, type UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { EscalationService } from "../src/services/escalation.ts";

it("stops the retries after an owner reply that 20+ newer group messages follow", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "escalation-reply-"));
  const configPath = path.join(directory, "eliza.json");
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  vi.stubEnv("ELIZA_CONFIG_PATH", configPath);
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", configPath);
  const ownerEntityId = randomUUID() as UUID;
  const otherEntityId = randomUUID() as UUID;
  await writeFile(
    configPath,
    JSON.stringify({
      agents: {
        defaults: {
          ownerContacts: {
            alpha: { channelId: "alpha-owner", entityId: ownerEntityId },
          },
          escalation: { channels: ["alpha"], waitMinutes: 60, maxRetries: 3 },
        },
      },
    }),
  );
  const agentId = randomUUID() as UUID;
  const runtime = new AgentRuntime({
    agentId,
    character: { name: "Escalation reply", bio: [], settings: {} },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(path.join(directory, "state.sqlite"), agentId),
  );
  const sends: string[] = [];
  try {
    await runtime.init();
    runtime.registerSendHandler("alpha", async (_rt, target, content) => {
      sends.push(String(content.text));
      return {
        id: randomUUID() as UUID,
        entityId: agentId,
        agentId,
        roomId: randomUUID() as UUID,
        content: { ...content, channelId: target.channelId },
        createdAt: Date.now(),
      };
    });

    const started = await EscalationService.startEscalation(
      runtime,
      "fixture failure",
      "needs review",
    );
    expect(sends).toHaveLength(1);

    const worldId = randomUUID() as UUID;
    const dmRoomId = randomUUID() as UUID;
    const groupRoomId = randomUUID() as UUID;
    for (const [roomId, type] of [
      [dmRoomId, ChannelType.DM],
      [groupRoomId, ChannelType.GROUP],
    ] as const) {
      await runtime.ensureConnection({
        entityId: ownerEntityId,
        roomId,
        worldId,
        userName: "owner",
        name: "Owner",
        source: "alpha",
        channelId: `alpha-${roomId}`,
        type,
      });
    }
    await runtime.ensureConnection({
      entityId: otherEntityId,
      roomId: groupRoomId,
      worldId,
      userName: "friend",
      name: "Friend",
      source: "alpha",
      channelId: `alpha-${groupRoomId}`,
      type: ChannelType.GROUP,
    });

    // The owner acknowledges in the DM; then a busy group they are in moves on.
    const repliedAt = Date.now() + 1_000;
    await runtime.createMemory(
      {
        id: randomUUID() as UUID,
        entityId: ownerEntityId,
        agentId,
        roomId: dmRoomId,
        content: { text: "ack, looking now", source: "alpha" },
        createdAt: repliedAt,
      },
      "messages",
    );
    for (let i = 0; i < 25; i++) {
      await runtime.createMemory(
        {
          id: randomUUID() as UUID,
          entityId: otherEntityId,
          agentId,
          roomId: groupRoomId,
          content: { text: `group chatter ${i}`, source: "alpha" },
          createdAt: repliedAt + 1_000 + i,
        },
        "messages",
      );
    }

    await EscalationService.checkEscalation(runtime, started.id);
    expect(sends).toHaveLength(1);
    expect(started.resolved).toBe(true);
  } finally {
    await EscalationService.stop(runtime);
    await runtime.close();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

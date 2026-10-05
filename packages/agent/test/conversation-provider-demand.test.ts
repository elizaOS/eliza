/** Real host providers, canonical audience checks and durable SQLite originals; no model or storage substitutions. */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  attestDeliveryAudienceFromCanonicalRoom,
  ChannelType,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { memoryAction } from "@elizaos/plugin-assistant";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it, vi } from "vitest";
import { recentMessagesProvider } from "../../../plugins/plugin-assistant/src/features/basic-capabilities/providers/recentMessages.ts";
import { selectV5PlannerStateProviderNames } from "../../../plugins/plugin-assistant/src/services/message/provider-state.ts";
import { recentConversationsProvider } from "../src/providers/recent-conversations.ts";
import { relevantConversationsProvider } from "../src/providers/relevant-conversations.ts";

it("loads cross-room originals only for their selected context while preserving full retrieval and live authorization", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "conversation-provider-demand-"),
  );
  const owner = randomUUID() as UUID;
  const runtime = new AgentRuntime({
    agentId: randomUUID() as UUID,
    character: {
      name: "Demand recall",
      bio: [],
      settings: { ELIZA_ADMIN_ENTITY_ID: owner },
    },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(
      join(directory, "agent.sqlite"),
      runtime.agentId,
    ),
  );
  await runtime.initialize({ skipMigrations: true });
  try {
    const worldId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const sourceRoomId = randomUUID() as UUID;
    const hashRoomId = stringToUuid("Demand recall-hash-memory-room");
    await runtime.createWorld({
      id: worldId,
      agentId: runtime.agentId,
      name: "Owner world",
      metadata: {
        roles: { [owner]: "OWNER" },
        roleSources: { [owner]: "owner" },
        ownership: { ownerId: owner },
      },
    });
    await runtime.createEntities([
      { id: owner, agentId: runtime.agentId, names: ["Owner"] },
      {
        id: runtime.agentId,
        agentId: runtime.agentId,
        names: ["Demand recall"],
      },
    ]);
    for (const id of [roomId, sourceRoomId, hashRoomId]) {
      await runtime.createRooms([
        {
          id,
          agentId: runtime.agentId,
          worldId,
          type: ChannelType.DM,
          source: "test",
        },
      ]);
      await runtime.addParticipant(owner, id);
      await runtime.addParticipant(runtime.agentId, id);
    }
    const current =
      "Keep the file's exact  spacing.\nUse my existing orchid notebook constraint.";
    const original = `My orchid notebook was blue.\n${"Exact original Ω🙂  spacing.\n".repeat(80)}END ORIGINAL`;
    const corrected =
      "My orchid notebook is orange now; preserve this correction.";
    for (const [id, text, source] of [
      [roomId, current, "test"],
      [sourceRoomId, original, "test"],
      [hashRoomId, corrected, "hash_memory"],
    ] as const) {
      await runtime.createMemory(
        {
          id: randomUUID() as UUID,
          roomId: id,
          entityId: owner,
          agentId: runtime.agentId,
          content: { text, source },
          createdAt: Date.now(),
        },
        "messages",
      );
    }
    for (const provider of [
      recentMessagesProvider,
      recentConversationsProvider,
      relevantConversationsProvider,
    ])
      runtime.registerProvider(provider);
    const message: Memory = {
      id: randomUUID() as UUID,
      entityId: owner,
      agentId: runtime.agentId,
      roomId,
      content: {
        text: "Write the exact supplied HTML to /tmp/example.html.",
        source: "test",
        channelType: ChannelType.DM,
      },
    };
    await attestDeliveryAudienceFromCanonicalRoom(runtime, message);
    const names = (contexts: Array<"files" | "memory" | "messaging">) =>
      selectV5PlannerStateProviderNames({
        runtime,
        message,
        selectedContexts: contexts,
        userRoles: ["OWNER"],
      });
    const files = names(["files"]);
    expect(files).toContain("RECENT_MESSAGES");
    expect(files).not.toContain(recentConversationsProvider.name);
    expect(files).not.toContain(relevantConversationsProvider.name);
    const modelCalls = vi.spyOn(runtime, "useModel");
    const currentState = await runtime.composeState(message, files, true, true);
    expect(modelCalls).not.toHaveBeenCalled();
    modelCalls.mockRestore();
    expect(currentState.text).toContain(current);
    expect(currentState.text).not.toContain("END ORIGINAL");
    for (const context of ["memory", "messaging"] as const) {
      expect(names([context])).toEqual(
        expect.arrayContaining([
          recentConversationsProvider.name,
          relevantConversationsProvider.name,
        ]),
      );
    }
    const emptyState = { text: "", values: {}, data: {} };
    const fallback = await recentConversationsProvider.get(
      runtime,
      message,
      emptyState,
    );
    expect(fallback.text).toContain(original);
    expect(fallback.text).toContain(corrected);
    // Explicit recall loads exact lexical originals even without an embedding provider.
    message.content.text = "What did I say about my orchid notebook?";
    const recalled = await relevantConversationsProvider.get(
      runtime,
      message,
      emptyState,
    );
    expect(recalled.text).toContain(corrected);
    runtime.registerAction(memoryAction);
    const manifest = await recentConversationsProvider.get(
      runtime,
      message,
      emptyState,
    );
    // A recall action only adds a room index; complete bodies stay inline.
    expect(manifest.text).toContain(original);
    expect(manifest.text).toContain(corrected);
    expect(manifest.text).toContain(
      "Room index for exact reads with MEMORY action=search, type=messages",
    );
    expect(manifest.text).toContain(`roomId=${sourceRoomId}`);
    const read = await memoryAction.handler(runtime, message, emptyState, {
      parameters: { op: "search", type: "messages", roomId: sourceRoomId },
    });
    expect(read).toMatchObject({ success: true });
    expect(JSON.stringify(read)).toContain(
      JSON.stringify(original).slice(1, -1),
    );
    // Membership changes invalidate the same previously attested turn.
    const guest = randomUUID() as UUID;
    await runtime.createEntities([
      { id: guest, agentId: runtime.agentId, names: ["Guest"] },
    ]);
    await runtime.addParticipant(guest, roomId);
    expect(
      (await recentConversationsProvider.get(runtime, message, emptyState))
        .text,
    ).toBe("");
    expect(
      (await relevantConversationsProvider.get(runtime, message, emptyState))
        .text,
    ).toBe("");
    expect(
      (
        await runtime.getMemories({
          roomId: sourceRoomId,
          tableName: "messages",
        })
      )[0]?.content.text,
    ).toBe(original);
  } finally {
    await runtime.stop();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

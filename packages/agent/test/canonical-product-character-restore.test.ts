/** Real canonical builder, init, SQLite and persisted-room restore. No model or live profile. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  type Memory,
  parseAndValidateCharacter,
  type UUID,
} from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { afterEach, expect, it, vi } from "vitest";
import { resolveClientChatAdminEntityId } from "../src/api/client-chat-admin.ts";
import { restoreConversationsFromDb } from "../src/api/conversation-restore.ts";
import {
  type ConversationRouteState,
  ensureOwnerConversation,
} from "../src/api/conversation-routes.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import {
  agentIdentityName,
  buildCharacterFromConfig,
} from "../src/runtime/build-character-config.ts";
import { prepareProductCharacterConfig } from "../src/runtime/prepare-product-character-config.ts";
import { syncCharacterIntoConfig } from "../src/services/character-persistence.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const brand = { name: "Alpha", bio: ["Approved synthetic product bio."] };

function serverState(
  runtime: AgentRuntime,
  config: ElizaConfig,
  activeConversationId?: string,
) {
  return {
    runtime,
    config,
    agentName: runtime.character.name,
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations: new Map(),
    activeConversationId,
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set(),
    broadcastWs: null,
    tradePermissionMode: "connectors-only",
  } as unknown as ConversationRouteState & { activeConversationId?: string };
}
async function open(config: ElizaConfig, filename: string) {
  const runtime = new AgentRuntime({
    character: buildCharacterFromConfig(config),
    enableAutonomy: false,
    logLevel: "fatal",
  });
  const model = vi.spyOn(runtime, "useModel").mockImplementation(async () => {
    throw Error("Identity fixture must not use a model");
  });
  const adapter = SQLiteDatabaseAdapter.create(filename, runtime.agentId);
  runtime.registerDatabaseAdapter(adapter);
  await runtime.initialize();
  return { runtime, adapter, model };
}
function historyShape(rows: Memory[]) {
  return rows.map((row) => ({
    id: row.id,
    agentId: row.agentId,
    entityId: row.entityId,
    roomId: row.roomId,
    createdAt: row.createdAt,
    content: row.content,
  }));
}

it.each([
  "implicit-default",
  "ui-only-retained",
  "legacy-named",
  "explicit-identity",
] as const)(
  "keeps real retained identity, owner rooms and all200 messages through canonical product rename (%s)",
  async (mode) => {
    const dir = await mkdtemp(
      path.join(tmpdir(), "canonical-brand-"),
    );
    const filename = path.join(dir, "state.sqlite");
    vi.stubEnv("ELIZA_STATE_DIR", dir);
    vi.stubEnv("ELIZA_CONFIG_PATH", path.join(dir, "eliza.json"));
    vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(dir, "eliza.json"));
    vi.stubEnv("ELIZA_DISABLE_LOCAL_CHARACTER", "1");
    const workspace = path.join(dir, "workspace");
    await mkdir(workspace);
    const config: ElizaConfig = {
      agents: {
        defaults: {
          workspace,
          ...(mode === "legacy-named" || mode === "explicit-identity"
            ? { adminEntityId: randomUUID() }
            : {}),
        },
        ...(mode === "legacy-named"
          ? {
              list: [
                {
                  id: "main",
                  name: "Retained Legacy",
                  default: true,
                  username: "retained-handle",
                  settings: { keptFlag: "kept" },
                },
              ],
            }
          : mode === "explicit-identity"
            ? {
                list: [
                  {
                    id: "primary-route",
                    default: true,
                    name: "Old Display",
                    identityName: "Retained Canonical Seed",
                    system: "Keep this operator system.",
                    settings: { keptFlag: "kept" },
                  },
                  {
                    id: "other-route",
                    default: false,
                    name: "Other Display",
                    identityName: "Other Seed",
                    bio: ["Other biography"],
                  },
                ],
              }
            : {}),
      },
      ui: {
        assistant: {
          name:
            mode === "ui-only-retained"
              ? "Retained UI Name"
              : mode === "legacy-named"
                ? "Retained Legacy"
                : mode === "explicit-identity"
                  ? "Old Display"
                  : "",
        },
        language: "en",
      },
      cloud: { enabled: false },
    } as ElizaConfig;
    saveElizaConfig(config);
    const originalConfig = loadElizaConfig();
    const originalSnapshot = structuredClone(originalConfig);
    let first: Awaited<ReturnType<typeof open>> | undefined,
      second: Awaited<ReturnType<typeof open>> | undefined,
      third: Awaited<ReturnType<typeof open>> | undefined;
    try {
      first = await open(originalConfig, filename);
      const originalId = first.runtime.agentId,
        originalIdentity = agentIdentityName(first.runtime.character),
        originalName = first.runtime.character.name;
      const state = serverState(first.runtime, originalConfig);
      const conversation = await ensureOwnerConversation(state, first.runtime);
      const owner = state.chatUserId!;
      const membersBefore =
        await first.runtime.getRoomsForParticipant(originalId);
      const ownerRoomsBefore =
        await first.runtime.getRoomsForParticipant(owner);
      const originalRoom = await first.runtime.getRoom(conversation.roomId);
      for (let index = 0; index < 200; index++) {
        await first.runtime.createMemory(
          {
            id: randomUUID() as UUID,
            agentId: originalId,
            entityId: index % 2 ? originalId : owner,
            roomId: conversation.roomId,
            createdAt: Date.UTC(2026, 0, 1) + index,
            content: {
              source: "client_chat",
              role: index % 2 ? "assistant" : "user",
              text:
                index === 1
                  ? `Historical self-label: ${originalName}. Keep this text unchanged.`
                  : `Retained message ${index}: don't change apostrophes or IDs.`,
            },
          },
          "messages",
        );
      }
      const before = historyShape(
        await first.runtime.getMemories({
          roomId: conversation.roomId,
          tableName: "messages",
          count: 1000,
        }),
      );
      expect(before).toHaveLength(200);
      const oldAgent = await first.runtime.getAgent(originalId);
      const oldEntity = await first.runtime.getEntityById(originalId);
      const next = prepareProductCharacterConfig(originalConfig, brand);
      expect(originalConfig).toEqual(originalSnapshot);
      expect(next.agents?.defaults).toEqual(originalConfig.agents?.defaults);
      expect(next.agents?.list?.slice(1)).toEqual(
        originalConfig.agents?.list?.slice(1) ?? [],
      );
      if (originalConfig.agents?.list?.length) {
        const old = originalConfig.agents.list[0],
          current = next.agents!.list![0];
        for (const field of [
          "id",
          "default",
          "username",
          "system",
          "settings",
        ] as const)
          expect(current[field]).toEqual(old[field]);
      } else
        expect(next.agents?.list?.[0]).toMatchObject({
          id: "main",
          default: true,
          identityName: originalIdentity,
        });
      expect(next.cloud).toEqual(originalConfig.cloud);
      const unchanged = structuredClone(next),
        expected = structuredClone(originalConfig);
      for (const value of [unchanged, expected]) {
        if (value.agents?.list?.[0]) {
          delete value.agents.list[0].name;
          delete value.agents.list[0].identityName;
          delete value.agents.list[0].bio;
        }
        if (value.ui?.assistant)
          delete (value.ui.assistant as { name?: string }).name;
      }
      if (!originalConfig.agents?.list?.length) {
        if (Object.hasOwn(originalConfig.agents ?? {}, "list"))
          unchanged.agents!.list = structuredClone(originalConfig.agents!.list);
        else delete unchanged.agents!.list;
      }
      expect(unchanged).toEqual(expected);
      expect(next.agents?.list?.[0].system).toBe(
        originalConfig.agents?.list?.[0]?.system,
      );
      saveElizaConfig(next);
      expect(first.model).not.toHaveBeenCalled();
      await first.runtime.stop();
      await first.runtime.close();
      first = undefined;
      second = await open(loadElizaConfig(), filename);
      expect(second.runtime.agentId).toBe(originalId);
      expect(agentIdentityName(second.runtime.character)).toBe(
        originalIdentity,
      );
      expect(second.runtime.character.name).toBe("Alpha");
      expect(second.runtime.character.bio).toEqual(brand.bio);
      const agent = await second.runtime.getAgent(originalId),
        entity = await second.runtime.getEntityById(originalId);
      expect(agent?.id).toBe(oldAgent?.id);
      expect(agent?.createdAt).toBe(oldAgent?.createdAt);
      expect(agent?.name).toBe("Alpha");
      expect(entity?.id).toBe(oldEntity?.id);
      expect(entity?.names[0]).toBe("Alpha");
      expect(entity?.names).toContain(originalName);
      expect(
        (await second.runtime.getAgents()).map((agent) => agent.id),
      ).toEqual([originalId]);
      const restored = serverState(
        second.runtime,
        loadElizaConfig(),
        conversation.id,
      );
      const count = await restoreConversationsFromDb(second.runtime, restored);
      expect(count).toBe(1);
      expect(restored.conversations.size).toBe(1);
      expect(restored.conversations.get(conversation.id)).toMatchObject({
        id: conversation.id,
        roomId: conversation.roomId,
        title: conversation.title,
      });
      const selected = await ensureOwnerConversation(restored, second.runtime);
      expect(selected.id).toBe(conversation.id);
      expect(selected.roomId).toBe(conversation.roomId);
      expect(resolveClientChatAdminEntityId(restored)).toBe(owner);
      expect(
        (await second.runtime.getRoomsForParticipant(owner)).sort(),
      ).toEqual(ownerRoomsBefore.sort());
      const retainedRoom = await second.runtime.getRoom(conversation.roomId);
      expect({
        worldId: retainedRoom?.worldId,
        messageServerId: retainedRoom?.messageServerId,
        channelId: retainedRoom?.channelId,
        source: retainedRoom?.source,
      }).toEqual({
        worldId: originalRoom?.worldId,
        messageServerId: originalRoom?.messageServerId,
        channelId: originalRoom?.channelId,
        source: originalRoom?.source,
      });
      expect(
        (await second.runtime.getRoomsForParticipant(originalId)).sort(),
      ).toEqual(membersBefore.sort());
      expect(
        historyShape(
          await second.runtime.getMemories({
            roomId: selected.roomId,
            tableName: "messages",
            count: 1000,
          }),
        ),
      ).toEqual(before);
      const repeated = prepareProductCharacterConfig(loadElizaConfig(), brand);
      expect(repeated).toEqual(loadElizaConfig());
      const validated = parseAndValidateCharacter(
        JSON.stringify(second.runtime.character),
      );
      expect(validated.success).toBe(true);
      const restoredConfig = structuredClone(repeated);
      // A validated backup character is authoritative even when the config mirror
      // has not retained identityName yet. Reuse normal sync before rebuilding.
      delete restoredConfig.agents!.list![0].identityName;
      syncCharacterIntoConfig(restoredConfig, {
        name: "Alpha",
        settings: validated.data?.settings,
      });
      const restoredBuilder = buildCharacterFromConfig(restoredConfig);
      expect(agentIdentityName(restoredBuilder)).toBe(originalIdentity);
      expect(second.model).not.toHaveBeenCalled();
      saveElizaConfig(restoredConfig);
      await second.runtime.stop();
      await second.runtime.close();
      second = undefined;
      third = await open(loadElizaConfig(), filename);
      expect(third.runtime.agentId).toBe(originalId);
      expect(agentIdentityName(third.runtime.character)).toBe(originalIdentity);
      const finalState = serverState(
        third.runtime,
        loadElizaConfig(),
        conversation.id,
      );
      await restoreConversationsFromDb(third.runtime, finalState);
      expect(
        (await ensureOwnerConversation(finalState, third.runtime)).id,
      ).toBe(conversation.id);
      expect(
        historyShape(
          await third.runtime.getMemories({
            roomId: conversation.roomId,
            tableName: "messages",
            count: 1000,
          }),
        ),
      ).toEqual(before);
      expect(
        (await third.runtime.getEntityById(originalId))?.names.filter(
          (name) => name === "Alpha",
        ),
      ).toHaveLength(1);
      expect(third.model).not.toHaveBeenCalled();
    } finally {
      if (first) {
        await first.runtime.stop();
        await first.runtime.close();
      }
      if (second) {
        await second.runtime.stop();
        await second.runtime.close();
      }
      if (third) {
        await third.runtime.stop();
        await third.runtime.close();
      }
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("uses the same canonical implicit identity on a fresh Alpha first boot", async () => {
  const dir = await mkdtemp(
    path.join(tmpdir(), "fresh-canonical-brand-"),
  );
  vi.stubEnv("ELIZA_STATE_DIR", dir);
  vi.stubEnv("ELIZA_CONFIG_PATH", path.join(dir, "eliza.json"));
  vi.stubEnv("ELIZA_PERSIST_CONFIG_PATH", path.join(dir, "eliza.json"));
  let baseline: Awaited<ReturnType<typeof open>> | undefined,
    candidate: Awaited<ReturnType<typeof open>> | undefined;
  try {
    saveElizaConfig({});
    const original = loadElizaConfig();
    baseline = await open(original, path.join(dir, "baseline.sqlite"));
    const originalId = baseline.runtime.agentId,
      identity = agentIdentityName(baseline.runtime.character);
    expect(baseline.model).not.toHaveBeenCalled();
    await baseline.runtime.stop();
    await baseline.runtime.close();
    baseline = undefined;
    const next = prepareProductCharacterConfig(original, brand);
    saveElizaConfig(next);
    candidate = await open(
      loadElizaConfig(),
      path.join(dir, "fresh-branded.sqlite"),
    );
    expect(candidate.runtime.agentId).toBe(originalId);
    expect(agentIdentityName(candidate.runtime.character)).toBe(identity);
    expect(candidate.runtime.character.name).toBe("Alpha");
    expect(
      (await candidate.runtime.getAgents()).map((agent) => agent.id),
    ).toEqual([originalId]);
    expect((await candidate.runtime.getEntityById(originalId))?.names).toEqual([
      "Alpha",
    ]);
    expect(candidate.model).not.toHaveBeenCalled();
  } finally {
    if (baseline) {
      await baseline.runtime.stop();
      await baseline.runtime.close();
    }
    if (candidate) {
      await candidate.runtime.stop();
      await candidate.runtime.close();
    }
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([
  {
    agents: {
      list: [
        { id: "first", name: "First" },
        { id: "second", name: "Second", default: true },
      ],
    },
  },
  { agents: { list: [{ id: "main", name: "Old", default: false }] } },
  { agents: { list: [{ id: "main", name: "Old", identityName: " " }] } },
  {
    agents: { list: [{ id: "main", name: "Old" }] },
    ui: { assistant: { name: "Conflicting display" } },
  },
])("refuses ambiguous canonical selection before mutation: %j", (config) => {
  const before = structuredClone(config);
  expect(() =>
    prepareProductCharacterConfig(config as ElizaConfig, brand),
  ).toThrowError(
    expect.objectContaining({ code: "PRODUCT_CHARACTER_IDENTITY_UNRESOLVED" }),
  );
  expect(config).toEqual(before);
});
it("does not accept product-supplied identity authority or provisioned route identity", () => {
  const config: ElizaConfig = {};
  expect(() =>
    prepareProductCharacterConfig(config, {
      name: "Alpha",
      id: randomUUID(),
    } as never),
  ).toThrowError(
    expect.objectContaining({ code: "PRODUCT_CHARACTER_FIELDS_INVALID" }),
  );
  vi.stubEnv("SANDBOX_ROUTE_AGENT_ID", randomUUID());
  expect(() => prepareProductCharacterConfig(config, brand)).toThrowError(
    expect.objectContaining({ code: "PRODUCT_CHARACTER_IDENTITY_UNRESOLVED" }),
  );
  vi.stubEnv("SANDBOX_ROUTE_AGENT_ID", "");
  vi.stubEnv(
    "ELIZA_AGENT_CHARACTER_JSON",
    JSON.stringify({ name: "Injected identity" }),
  );
  expect(() => prepareProductCharacterConfig(config, brand)).toThrowError(
    expect.objectContaining({ code: "PRODUCT_CHARACTER_IDENTITY_UNRESOLVED" }),
  );
  expect(config).toEqual({});
});

/**
 * Covers MESSAGE op=send smart routing: the exact-beats-prefix confidence
 * tier, the unresolved-recipient upfront clarify, the last-delivered-channel
 * preference (write + read), and the admin/owner shortcut over the current /
 * internal transport. Deterministic mock runtime and connectors — no live
 * model, no DB.
 */

import type {
  ActionResult,
  Component,
  IAgentRuntime,
  Memory,
  UUID,
} from "@elizaos/core";
import { ServiceType } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it, vi } from "vitest";
import { messageAction } from "./message.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const ROOM_ID = "00000000-0000-0000-0000-0000000000bb";
const SENDER_ID = "00000000-0000-0000-0000-0000000000cc";
const SHADOW_ID = "00000000-0000-0000-0000-0000000000e7";
const WORLD_ID = "00000000-0000-0000-0000-0000000000e8";
const DISCORD_ACCOUNT_ID = "00000000-0000-0000-0000-0000000000d1";
const TELEGRAM_ACCOUNT_ID = "00000000-0000-0000-0000-0000000000d2";

const baseMessage = {
  id: "00000000-0000-0000-0000-0000000000aa",
  roomId: ROOM_ID,
  entityId: SENDER_ID,
  agentId: AGENT_ID,
  content: { text: "tell shadow to stop smoking", source: "discord" },
  createdAt: 1,
} as unknown as Memory;

type SentMessage = {
  target: Record<string, unknown>;
  text: string;
  metadata?: Record<string, unknown>;
};

async function send(
  runtime: IAgentRuntime,
  params: Record<string, unknown>,
  message: Memory = baseMessage,
): Promise<ActionResult> {
  const result = await messageAction.handler(
    runtime,
    message,
    undefined,
    { parameters: { action: "send", persist: false, ...params } },
    undefined,
    undefined,
  );
  if (!result) throw new Error("handler returned no result");
  return result;
}

describe("MESSAGE op=send exact-beats-prefix tier (ambiguity over-fire fix)", () => {
  function harness(hookCandidates: Array<Record<string, unknown>>) {
    const sends: SentMessage[] = [];
    const resolveTargets = vi.fn(async () => hookCandidates);
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getMessageConnectors: () => [
        {
          source: "discord",
          label: "Discord",
          capabilities: [],
          supportedTargetKinds: ["user", "room", "channel"],
          contexts: [],
          resolveTargets,
        },
      ],
      getRoom: async () => null,
      getEntitiesForRoom: async () => [],
      getEntityById: (async () => null) as IAgentRuntime["getEntityById"],
      getRelationships: (async () => []) as IAgentRuntime["getRelationships"],
      getSetting: (() => null) as IAgentRuntime["getSetting"],
      sendMessageToTarget: async (target, content) => {
        sends.push({
          target: target as unknown as Record<string, unknown>,
          text: String(content.text ?? ""),
        });
        return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
      },
      useModel: async () => {
        throw new Error("resolution must be deterministic — no model call");
      },
      reportError: () => undefined,
    });
    return { runtime, sends, resolveTargets };
  }

  it("an exact label match beats a prefix match instead of tripping the ambiguity brake", async () => {
    const { runtime, sends } = harness([
      {
        target: { source: "discord", channelId: "dm-shadow", entityId: "111" },
        label: "shadow",
        kind: "user",
        score: 0.95,
        contexts: [],
      },
      {
        target: {
          source: "discord",
          channelId: "dm-shadowfax",
          entityId: "222",
        },
        label: "shadowfax",
        kind: "user",
        score: 0.85,
        contexts: [],
      },
    ]);
    const result = await send(runtime, {
      target: "shadow",
      targetKind: "user",
      message: "stop smoking",
    });

    expect(result.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toMatchObject({ channelId: "dm-shadow" });
  });

  it("returns every exact ambiguous match instead of a hidden candidate window", async () => {
    const matches = Array.from({ length: 12 }, (_, index) => ({
      target: {
        source: "discord",
        channelId: `dm-shadow-${index}`,
        entityId: String(index),
      },
      label: "shadow",
      kind: "user",
      score: 0.95,
      contexts: [],
    }));
    const { runtime, sends } = harness(matches);
    const result = await send(runtime, {
      target: "shadow",
      targetKind: "user",
      message: "stop smoking",
    });

    expect(result.success).toBe(false);
    expect((result.data as { error?: string })?.error).toBe("TARGET_AMBIGUOUS");
    expect(
      (result.data as { candidates?: unknown[] })?.candidates,
    ).toHaveLength(12);
    expect(sends).toHaveLength(0);
  });
});

describe("MESSAGE op=send unresolved recipient asks upfront (no doomed send)", () => {
  function harness(matchingLiteralEntity = false) {
    const sends: SentMessage[] = [];
    const cache = new Map<string, unknown>();
    const literalEntity = {
      id: SHADOW_ID,
      agentId: AGENT_ID,
      names: ["shadow@example.com"],
      components: [],
    };
    const runtime = createMockRuntime({
      getCache: (async (key: string) =>
        cache.get(key)) as IAgentRuntime["getCache"],
      compareAndSetCache: async (key, expected, replacement) => {
        if (JSON.stringify(cache.get(key)) !== JSON.stringify(expected))
          return false;
        cache.set(key, structuredClone(replacement));
        return true;
      },
      setCache: (async (key: string, value: unknown) => {
        cache.set(key, value);
        return true;
      }) as IAgentRuntime["setCache"],
      deleteCache: (async (key: string) =>
        cache.delete(key)) as IAgentRuntime["deleteCache"],
      agentId: AGENT_ID,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getMessageConnectors: () => [
        {
          source: "discord",
          label: "Discord",
          capabilities: [],
          supportedTargetKinds: ["user", "room", "channel", "email"],
          contexts: [],
          resolveTargets: async () => [],
        },
      ],
      getRoom: async () => null,
      getEntitiesForRoom: async () =>
        matchingLiteralEntity ? [literalEntity] : [],
      getEntityById: (async (id: string) =>
        matchingLiteralEntity && id === SHADOW_ID
          ? literalEntity
          : null) as IAgentRuntime["getEntityById"],
      getRelationships: (async () => []) as IAgentRuntime["getRelationships"],
      getSetting: (() => null) as IAgentRuntime["getSetting"],
      sendMessageToTarget: async (target, content) => {
        sends.push({
          target: target as unknown as Record<string, unknown>,
          text: String(content.text ?? ""),
          metadata: content.metadata as Record<string, unknown>,
        });
        return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
      },
      useModel: async () => {
        throw new Error("resolution must be deterministic — no model call");
      },
      reportError: () => undefined,
    });
    return { runtime, sends };
  }

  it("an unresolvable bare name fails fast with a clarify, not a shipped send", async () => {
    const { runtime, sends } = harness();
    const result = await send(runtime, {
      target: "shadow",
      message: "stop smoking",
    });

    expect(result.success).toBe(false);
    expect((result.data as { error?: string })?.error).toBe(
      "TARGET_UNRESOLVED_RECIPIENT",
    );
    expect(result.text).toContain('"shadow"');
    expect(result.data).not.toMatchObject({ confirmationRequired: true });
    expect(sends).toHaveLength(0);
  });

  it("a literal email address is address-routed and delivers without a contact lookup", async () => {
    const { runtime, sends } = harness(true);
    const result = await send(runtime, {
      target: "shadow@example.com",
      message: "stop smoking",
      subject: "A friendly reminder",
    });

    expect(result.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toMatchObject({
      channelId: "shadow@example.com",
    });
    expect(sends[0].metadata).toMatchObject({
      subject: "A friendly reminder",
    });
  });

  it("a numeric platform id stays on the explicit path (not treated as an unknown name)", async () => {
    const { runtime } = harness();
    const result = await send(runtime, {
      target: "555000111222333",
      targetKind: "user",
      message: "hey",
    });

    // The raw platform id proceeds to the recipient gate (confirmation),
    // never the unresolved-name clarify.
    expect((result.data as { error?: string })?.error).not.toBe(
      "TARGET_UNRESOLVED_RECIPIENT",
    );
  });
});

describe("MESSAGE op=send last-delivered-channel preference", () => {
  function shadowEntity(withPreference: boolean) {
    const components: Array<{
      id: string;
      type: string;
      sourceEntityId: string;
      data: Record<string, unknown>;
    }> = [];
    if (withPreference) {
      components.push({
        id: "00000000-0000-0000-0000-0000000000c3",
        type: "message_delivery_preference",
        sourceEntityId: AGENT_ID,
        data: { source: "telegram" },
      });
    }
    return {
      id: SHADOW_ID,
      names: ["Shadow"],
      agentId: AGENT_ID,
      components,
    };
  }

  function harness(options: {
    withPreference: boolean;
    storedPreference?: Component;
    roomWorldId?: UUID | null;
  }) {
    const sends: SentMessage[] = [];
    const components: Component[] = options.storedPreference
      ? [options.storedPreference]
      : [];
    const created: Component[] = [];
    const updated: Component[] = [];
    const reported: unknown[] = [];
    const entity = shadowEntity(options.withPreference);
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getMessageConnectors: () => [
        {
          source: "discord",
          label: "Discord",
          capabilities: [],
          supportedTargetKinds: ["user", "contact"],
          contexts: [],
          resolveTargets: async () => [
            {
              target: { source: "discord", channelId: "attacker-hook" },
              label: "Shadow",
              kind: "user" as const,
              score: 1,
              contexts: [],
            },
          ],
          resolveIdentityClaimTarget: async (claim: {
            externalSubjectId: string;
          }) => ({
            identityDeliveryKey: claim.externalSubjectId,
            target: {
              source: "discord",
              entityId: claim.externalSubjectId,
            },
            label: claim.externalSubjectId,
            kind: "user" as const,
            contexts: [],
          }),
        },
        {
          source: "telegram",
          label: "Telegram",
          capabilities: [],
          supportedTargetKinds: ["user", "contact"],
          contexts: [],
          resolveIdentityClaimTarget: async (claim: {
            externalSubjectId: string;
          }) => ({
            identityDeliveryKey: claim.externalSubjectId,
            target: {
              source: "telegram",
              channelId: claim.externalSubjectId,
            },
            label: claim.externalSubjectId,
            kind: "user" as const,
            contexts: [],
          }),
        },
      ],
      getSetting: ((key: string) =>
        key === "IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE"
          ? "true"
          : null) as IAgentRuntime["getSetting"],
      getService: ((serviceType: string) => {
        if (serviceType !== ServiceType.PRINCIPAL) return null;
        return {
          resolveIdentityDeliveryClaim: async (request: {
            principalId: string;
            connectorId?: string;
          }) => {
            const discord = request.connectorId === "discord";
            const accountId = discord
              ? DISCORD_ACCOUNT_ID
              : TELEGRAM_ACCOUNT_ID;
            const handle = discord ? "@shadow-discord" : "@shadow-telegram";
            const externalSubjectId = discord
              ? "discord-user-123"
              : "telegram-chat-456";
            return {
              decision: "resolved",
              requestedPrincipalId: request.principalId,
              canonicalPrincipalId: SHADOW_ID,
              generation: 3,
              claim: {
                id: discord
                  ? "00000000-0000-0000-0000-0000000000f1"
                  : "00000000-0000-0000-0000-0000000000f2",
                connectorId: request.connectorId,
                connectorAccountId: accountId,
                handle,
                externalSubjectId,
              },
            };
          },
        };
      }) as IAgentRuntime["getService"],
      // The room's source has no registered connector, so the room-first
      // member path stays out of the way and the entity path is exercised.
      getRoom: async () => ({
        id: ROOM_ID,
        name: "app",
        source: "app",
        ...(options.roomWorldId === null
          ? {}
          : { worldId: options.roomWorldId ?? WORLD_ID }),
      }),
      getEntitiesForRoom: async () => [entity],
      getWorld: (async () => null) as IAgentRuntime["getWorld"],
      getEntityById: (async (id: string) =>
        id === SHADOW_ID ? entity : null) as IAgentRuntime["getEntityById"],
      getRelationships: (async () => []) as IAgentRuntime["getRelationships"],
      getMemories: (async () => []) as IAgentRuntime["getMemories"],
      sendMessageToTarget: async (target, content) => {
        sends.push({
          target: target as unknown as Record<string, unknown>,
          text: String(content.text ?? ""),
        });
        return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
      },
      getComponents: (async () => components) as IAgentRuntime["getComponents"],
      createComponent: (async (component: Component) => {
        created.push(component);
        components.push(component);
        return true;
      }) as IAgentRuntime["createComponent"],
      updateComponent: (async (component: Component) => {
        updated.push(component);
      }) as IAgentRuntime["updateComponent"],
      // findEntityByName degrades to its sole-candidate heuristic on
      // unparseable model output — resolution stays deterministic.
      useModel: (async () => "not-json") as IAgentRuntime["useModel"],
      reportError: ((_scope: string, error: unknown) => {
        reported.push(error);
      }) as IAgentRuntime["reportError"],
    });
    return { runtime, sends, created, updated, reported };
  }

  it("without a recorded preference, two verified connector claims stay ambiguous", async () => {
    const { runtime, sends } = harness({ withPreference: false });
    const message = {
      ...baseMessage,
      content: { text: "tell shadow to stop smoking", source: "app" },
    } as Memory;
    const result = await send(
      runtime,
      { target: "shadow", message: "stop smoking" },
      message,
    );

    expect(result.success).toBe(false);
    expect((result.data as { error?: string })?.error).toBe("TARGET_AMBIGUOUS");
    expect(sends).toHaveLength(0);
  });

  it("preserves a connector-owned provider entity target and excludes discovery hooks", async () => {
    const { runtime, sends } = harness({ withPreference: false });
    const result = await send(runtime, {
      source: "discord",
      target: "shadow",
      targetKind: "user",
      message: "stop smoking",
    });

    expect(result.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toMatchObject({
      source: "discord",
      entityId: "discord-user-123",
    });
    expect(sends[0].target).not.toHaveProperty("channelId");
  });

  it("prefers the channel the person was last reached on", async () => {
    const { runtime, sends } = harness({ withPreference: true });
    const message = {
      ...baseMessage,
      content: { text: "tell shadow to stop smoking", source: "app" },
    } as Memory;
    const result = await send(
      runtime,
      { target: "shadow", message: "stop smoking" },
      message,
    );

    expect(result.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toMatchObject({
      source: "telegram",
      channelId: "telegram-chat-456",
    });
    expect(
      (result.data as { resolutionReasons?: string[] })?.resolutionReasons,
    ).toContain("lastChannel");
  });

  it("a successful entity delivery records the channel for next time", async () => {
    const { runtime, created, updated } = harness({ withPreference: true });
    const message = {
      ...baseMessage,
      content: { text: "tell shadow to stop smoking", source: "app" },
    } as Memory;
    const result = await send(
      runtime,
      { target: "shadow", message: "stop smoking" },
      message,
    );

    expect(result.success).toBe(true);
    expect(updated).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      entityId: SHADOW_ID,
      worldId: WORLD_ID,
      type: "message_delivery_preference",
      data: { source: "telegram" },
    });
  });

  it("updates the person's one preference in place when reached from another world", async () => {
    // A preference first recorded from a different world; the adapter's upsert
    // keys on worldId, so writing the same fixed id from this world inserted a
    // duplicate primary key.
    const storedPreference = {
      id: "00000000-0000-0000-0000-0000000000a1",
      entityId: SHADOW_ID,
      agentId: AGENT_ID,
      roomId: "00000000-0000-0000-0000-0000000000a2",
      worldId: "00000000-0000-0000-0000-0000000000a3",
      sourceEntityId: AGENT_ID,
      type: "message_delivery_preference",
      createdAt: 1,
      data: { source: "telegram" },
    } as unknown as Component;
    const { runtime, created, updated } = harness({
      withPreference: true,
      storedPreference,
    });
    const message = {
      ...baseMessage,
      content: { text: "tell shadow to stop smoking", source: "app" },
    } as Memory;
    const result = await send(
      runtime,
      { target: "shadow", message: "stop smoking" },
      message,
    );

    expect(result.success).toBe(true);
    expect(created).toHaveLength(0);
    expect(updated).toEqual([
      expect.objectContaining({
        id: storedPreference.id,
        worldId: storedPreference.worldId,
        roomId: ROOM_ID,
        data: expect.objectContaining({ source: "telegram" }),
      }),
    ]);
  });

  it("records no preference under an invented world when the room has none", async () => {
    const { runtime, created, updated, reported } = harness({
      withPreference: true,
      roomWorldId: null,
    });
    const message = {
      ...baseMessage,
      content: { text: "tell shadow to stop smoking", source: "app" },
    } as Memory;
    const result = await send(
      runtime,
      { target: "shadow", message: "stop smoking" },
      message,
    );

    expect(result.success).toBe(true);
    expect(created).toHaveLength(0);
    expect(updated).toHaveLength(0);
    expect(reported).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining(
          "no world to record the delivery preference",
        ),
      }),
    );
  });
});

describe("MESSAGE op=send admin/owner target (app + connector transports)", () => {
  it("resolves 'owner' through the internal client_chat transport when no connector is registered", async () => {
    const sends: SentMessage[] = [];
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getMessageConnectors: () => [],
      getRoom: async () => null,
      getSetting: (() => undefined) as IAgentRuntime["getSetting"],
      sendMessageToTarget: async (target, content) => {
        sends.push({
          target: target as unknown as Record<string, unknown>,
          text: String(content.text ?? ""),
        });
        return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
      },
      useModel: async () => {
        throw new Error("admin resolution must be deterministic");
      },
      reportError: () => undefined,
    });
    (
      runtime as unknown as { sendHandlers: Map<string, unknown> }
    ).sendHandlers = new Map([["client_chat", async () => undefined]]);

    const message = {
      ...baseMessage,
      content: {
        text: "message the owner that I'm done",
        source: "client_chat",
      },
    } as Memory;
    const result = await send(
      runtime,
      { target: "owner", message: "the report is done" },
      message,
    );

    expect(result.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toMatchObject({
      source: "client_chat",
      roomId: ROOM_ID,
    });
  });

  it("resolves 'admin' over the current conversation's connector, never a fuzzy user match", async () => {
    const sends: SentMessage[] = [];
    const resolveTargets = vi.fn(async () => [
      {
        target: { source: "discord", entityId: "999" },
        label: "@adminlarper",
        kind: "user" as const,
        score: 0.95,
        contexts: [],
      },
    ]);
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getMessageConnectors: () => [
        {
          source: "discord",
          label: "Discord",
          capabilities: [],
          supportedTargetKinds: ["user", "room", "channel"],
          contexts: [],
          resolveTargets,
        },
      ],
      getRoom: async () => null,
      getSetting: (() => undefined) as IAgentRuntime["getSetting"],
      sendMessageToTarget: async (target, content) => {
        sends.push({
          target: target as unknown as Record<string, unknown>,
          text: String(content.text ?? ""),
        });
        return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
      },
      useModel: async () => {
        throw new Error("admin resolution must be deterministic");
      },
      reportError: () => undefined,
    });

    const result = await send(runtime, {
      target: "admin",
      message: "task finished",
    });

    expect(result.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toMatchObject({ source: "discord" });
    expect(sends[0].target.entityId).toBeDefined();
    expect(resolveTargets).not.toHaveBeenCalled();
  });
});

describe("MESSAGE op=send delivery-claim ambiguity is judged on distinct destinations", () => {
  function harness(options: {
    claimsAuthoritative: boolean;
    claims: Array<{
      id: string;
      handle: string | null;
      externalSubjectId: string;
    }>;
  }) {
    const sends: SentMessage[] = [];
    const entity = {
      id: SHADOW_ID,
      names: ["Shadow"],
      agentId: AGENT_ID,
      components: [
        {
          id: "00000000-0000-0000-0000-0000000000c4",
          type: "discord",
          sourceEntityId: AGENT_ID,
          data: { channelId: "component-dm-shadow" },
        },
      ],
    };
    const runtime = createMockRuntime({
      agentId: AGENT_ID,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      getMessageConnectors: () => [
        {
          source: "discord",
          label: "Discord",
          capabilities: [],
          supportedTargetKinds: ["user", "contact"],
          contexts: [],
          resolveIdentityClaimTarget: async (claim: {
            handle: string | null;
            externalSubjectId: string;
          }) => ({
            identityDeliveryKey: claim.handle ?? claim.externalSubjectId,
            target: {
              source: "discord",
              channelId: claim.handle ?? claim.externalSubjectId,
            },
            label: claim.handle ?? claim.externalSubjectId,
            kind: "user" as const,
            contexts: [],
          }),
        },
      ],
      getSetting: ((key: string) =>
        key === "IDENTITY_DELIVERY_CLAIMS_AUTHORITATIVE" &&
        options.claimsAuthoritative
          ? "true"
          : null) as IAgentRuntime["getSetting"],
      getService: ((serviceType: string) => {
        if (serviceType !== ServiceType.PRINCIPAL) return null;
        return {
          resolveIdentityDeliveryClaim: async (request: {
            principalId: string;
          }) => {
            const claims = options.claims.map((claim) => ({
              ...claim,
              connectorId: "discord",
              connectorAccountId: DISCORD_ACCOUNT_ID,
            }));
            if (claims.length === 1) {
              return {
                decision: "resolved",
                requestedPrincipalId: request.principalId,
                canonicalPrincipalId: SHADOW_ID,
                generation: 3,
                claim: claims[0],
              };
            }
            return {
              decision: "ambiguous",
              requestedPrincipalId: request.principalId,
              canonicalPrincipalId: SHADOW_ID,
              generation: 3,
              claims,
              reason: "multiple_verified_claims",
            };
          },
        };
      }) as IAgentRuntime["getService"],
      getRoom: async () => ({ id: ROOM_ID, name: "app", source: "app" }),
      getEntitiesForRoom: async () => [entity],
      getWorld: (async () => null) as IAgentRuntime["getWorld"],
      getEntityById: (async (id: string) =>
        id === SHADOW_ID ? entity : null) as IAgentRuntime["getEntityById"],
      getRelationships: (async () => []) as IAgentRuntime["getRelationships"],
      getMemories: (async () => []) as IAgentRuntime["getMemories"],
      sendMessageToTarget: async (target, content) => {
        sends.push({
          target: target as unknown as Record<string, unknown>,
          text: String(content.text ?? ""),
        });
        return { id: "00000000-0000-0000-0000-0000000000ff" } as Memory;
      },
      upsertComponent: (async () =>
        undefined) as IAgentRuntime["upsertComponent"],
      useModel: (async () => "not-json") as IAgentRuntime["useModel"],
      reportError: () => undefined,
    });
    return { runtime, sends };
  }

  const appMessage = {
    ...baseMessage,
    content: { text: "tell shadow to stop smoking", source: "app" },
  } as Memory;

  it("two verified claims mapping to one delivery key resolve instead of refusing", async () => {
    const { runtime, sends } = harness({
      claimsAuthoritative: true,
      claims: [
        {
          id: "00000000-0000-0000-0000-0000000000f1",
          handle: "@shadow",
          externalSubjectId: "discord-user-123",
        },
        {
          id: "00000000-0000-0000-0000-0000000000f2",
          handle: "@shadow",
          externalSubjectId: "discord-user-123-alt",
        },
      ],
    });
    const result = await send(
      runtime,
      { target: "shadow", message: "stop smoking" },
      appMessage,
    );

    expect(result.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toMatchObject({ channelId: "@shadow" });
  });

  it("claims mapping to distinct delivery keys stay a choice with no duplicate entries", async () => {
    const { runtime, sends } = harness({
      claimsAuthoritative: true,
      claims: [
        {
          id: "00000000-0000-0000-0000-0000000000f1",
          handle: "@shadow-work",
          externalSubjectId: "discord-user-123",
        },
        {
          id: "00000000-0000-0000-0000-0000000000f2",
          handle: "@shadow-work",
          externalSubjectId: "discord-user-123",
        },
        {
          id: "00000000-0000-0000-0000-0000000000f3",
          handle: "@shadow-personal",
          externalSubjectId: "discord-user-456",
        },
      ],
    });
    const result = await send(
      runtime,
      { target: "shadow", message: "stop smoking" },
      appMessage,
    );

    expect(result.success).toBe(false);
    expect((result.data as { error?: string })?.error).toBe("TARGET_AMBIGUOUS");
    const candidates = (
      result.data as { candidates?: Array<{ label?: string }> }
    )?.candidates;
    expect(candidates).toHaveLength(2);
    expect(sends).toHaveLength(0);
  });

  it("with the rollout flag off, the legacy entity-component path routes the send", async () => {
    const { runtime, sends } = harness({
      claimsAuthoritative: false,
      claims: [],
    });
    const result = await send(
      runtime,
      { target: "shadow", message: "stop smoking" },
      appMessage,
    );

    expect(result.success).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0].target).toMatchObject({
      source: "discord",
      channelId: "component-dm-shadow",
    });
  });
});

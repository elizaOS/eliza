import type { Memory, UUID } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { pageScopedContextProvider } from "./page-scoped-context.js";

const AGENT_ID = "agent-1" as UUID;

function pageRoomMetadata(scope: string, overrides?: Record<string, unknown>) {
  return {
    webConversation: {
      conversationId: "page-conv-1",
      scope,
      ...overrides,
    },
  };
}

function buildMessage(overrides?: Partial<Memory>): Memory {
  return {
    id: "msg-1" as UUID,
    roomId: "room-1" as UUID,
    entityId: "user-1" as UUID,
    content: { text: "what can I do here?" },
    ...overrides,
  } as Memory;
}

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    json: async () => payload,
  } as Response;
}

describe("pageScopedContextProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns empty for non-page-scoped rooms", async () => {
    const runtime = {
      agentId: AGENT_ID,
      getRoom: vi.fn(async () => ({ id: "room-1", metadata: {} })),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );
    expect(result).toEqual({ text: "", values: {}, data: {} });
  });

  it("returns empty for automation-scoped rooms (different scope family)", async () => {
    const runtime = {
      agentId: AGENT_ID,
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: {
          webConversation: {
            conversationId: "auto-1",
            scope: "automation-workflow",
          },
        },
      })),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );
    expect(result.text).toBe("");
  });

  it("injects the character brief and live state for page-character", async () => {
    const runtime = {
      agentId: AGENT_ID,
      character: {
        name: "Eliza",
        bio: "A helpful local-first assistant.",
        messageExamples: [[], []],
      },
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-character"),
      })),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );
    expect(result.text).toContain("Character view");
    expect(result.text).toContain("Live character state:");
    expect(result.text).toContain("Eliza");
    expect(result.text).toContain("Message examples: 2");
    expect(result.values?.pageScope).toBe("page-character");
    expect(result.values?.sourceTailIncluded).toBe(false);
  });

  it("injects the automations brief and live task list", async () => {
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-automations"),
      })),
      getTasks: vi.fn(async () => [
        { id: "t1", name: "Daily check-in", tags: ["trigger"] },
        { id: "t2", name: "Email digest" },
      ]),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );
    expect(result.text).toContain("Automations view");
    expect(result.text).toContain("Live automations state: 2 tasks.");
    expect(result.text).toContain("Daily check-in");
    expect(result.text).toContain("Email digest");
  });

  it("injects the apps brief and live catalog/run state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/catalog/apps") {
        return jsonResponse([
          {
            name: "chess-coach",
            displayName: "Chess Coach",
            description: "Practice chess lines.",
            category: "game",
            launchType: "session",
            launchUrl: null,
            icon: null,
            heroImage: null,
            capabilities: ["commands", "telemetry"],
            stars: 0,
            repository: "",
            latestVersion: null,
            supports: { v0: false, v1: true, v2: true },
            npm: {
              package: "",
              v0Version: null,
              v1Version: null,
              v2Version: null,
            },
          },
        ]);
      }
      if (path === "/api/apps") return jsonResponse([]);
      if (path === "/api/apps/runs") {
        return jsonResponse([
          {
            appName: "chess-coach",
            displayName: "Chess Coach",
            status: "running",
            summary: "Waiting for the next move.",
            health: { state: "healthy", message: null },
            viewerAttachment: "attached",
          },
        ]);
      }
      return jsonResponse(null);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = {
      agentId: AGENT_ID,
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-apps"),
      })),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );

    expect(result.text).toContain("Apps view");
    expect(result.text).toContain("Live apps state:");
    expect(result.text).toContain("Running apps:");
    expect(result.text).toContain("Chess Coach");
    expect(result.text).toContain("Catalog sample:");
  });

  it("injects the LifeOps brief and live overview state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/lifeops/overview") {
        return jsonResponse({
          occurrences: [],
          goals: [],
          reminders: [],
          summary: {
            activeOccurrenceCount: 2,
            overdueOccurrenceCount: 1,
            snoozedOccurrenceCount: 0,
            activeReminderCount: 1,
            activeGoalCount: 1,
          },
          owner: {
            occurrences: [],
            goals: [
              {
                title: "Sleep before midnight",
                status: "active",
              },
            ],
            reminders: [
              {
                title: "Drink water",
                channel: "push",
                state: "upcoming",
                scheduledFor: "2026-04-22T21:00:00.000Z",
              },
            ],
            summary: {
              activeOccurrenceCount: 1,
              overdueOccurrenceCount: 0,
              snoozedOccurrenceCount: 0,
              activeReminderCount: 1,
              activeGoalCount: 1,
            },
          },
          agentOps: {
            occurrences: [],
            goals: [],
            reminders: [],
            summary: {
              activeOccurrenceCount: 0,
              overdueOccurrenceCount: 0,
              snoozedOccurrenceCount: 0,
              activeReminderCount: 0,
              activeGoalCount: 0,
            },
          },
          schedule: null,
        });
      }
      if (url.pathname === "/api/lifeops/capabilities") {
        return jsonResponse({
          generatedAt: "2026-04-22T20:00:00.000Z",
          appEnabled: true,
          relativeTime: null,
          capabilities: [
            {
              id: "calendar",
              domain: "connectors",
              label: "Calendar",
              state: "blocked",
              summary: "Google Calendar needs setup",
              confidence: 1,
              lastCheckedAt: "2026-04-22T20:00:00.000Z",
              evidence: [],
            },
          ],
          summary: {
            totalCount: 1,
            workingCount: 0,
            degradedCount: 0,
            blockedCount: 1,
            notConfiguredCount: 0,
          },
        });
      }
      if (url.pathname === "/api/lifeops/inbox/unified") {
        return jsonResponse({
          messages: [
            {
              id: "gmail-1",
              channel: "gmail",
              sender: {
                id: "sender-1",
                displayName: "Ada",
                avatarUrl: null,
              },
              subject: "Launch",
              snippet: "Can you review the launch checklist?",
              receivedAt: "2026-04-22T19:00:00.000Z",
              unread: true,
              deepLink: null,
              sourceRef: {
                channel: "gmail",
                externalId: "msg-1",
              },
            },
          ],
          channelCounts: {
            gmail: { total: 1, unread: 1 },
          },
          fetchedAt: "2026-04-22T20:00:00.000Z",
        });
      }
      return jsonResponse(null);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = {
      agentId: AGENT_ID,
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-lifeops"),
      })),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );

    expect(result.text).toContain("LifeOps view");
    expect(result.text).toContain("Live LifeOps state:");
    expect(result.text).toContain("Capabilities: 0 working");
    expect(result.text).toContain("Drink water");
    expect(result.text).toContain("Sleep before midnight");
    expect(result.text).toContain("Unified inbox");
  });

  it("injects the wallet brief and live wallet readiness state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path === "/api/wallet/config") {
        return jsonResponse({
          selectedRpcProviders: {
            evm: "eliza-cloud",
            bsc: "eliza-cloud",
            solana: "helius-birdeye",
          },
          walletSource: "managed",
          evmAddress: "0x1234567890abcdefabcd",
          solanaAddress: "So11111111111111111111111111111111111111112",
          managedBscRpcReady: true,
          evmBalanceReady: true,
          solanaBalanceReady: false,
          executionReady: false,
          executionBlockedReason: "User signing required",
          evmSigningCapability: "cloud-view-only",
          solanaSigningAvailable: false,
        });
      }
      if (path === "/api/wallet/balances") {
        return jsonResponse({
          evm: {
            address: "0x1234567890abcdefabcd",
            chains: [
              {
                chain: "bsc",
                chainId: 56,
                nativeBalance: "0.1",
                nativeSymbol: "BNB",
                nativeValueUsd: "50",
                tokens: [],
                error: null,
              },
            ],
          },
          solana: {
            address: "So11111111111111111111111111111111111111112",
            solBalance: "1",
            solValueUsd: "100",
            tokens: [],
          },
        });
      }
      if (path === "/api/wallet/nfts") {
        return jsonResponse({ evm: [], solana: null });
      }
      if (path === "/api/wallet/trading/profile") {
        return jsonResponse({
          window: "24h",
          source: "all",
          generatedAt: new Date().toISOString(),
          summary: {
            totalSwaps: 1,
            buyCount: 1,
            sellCount: 0,
            settledCount: 1,
            successCount: 1,
            revertedCount: 0,
            tradeWinRate: null,
            txSuccessRate: 100,
            winningTrades: 0,
            evaluatedTrades: 0,
            realizedPnlBnb: "0",
            volumeBnb: "0.1",
          },
          pnlSeries: [],
          tokenBreakdown: [],
          recentSwaps: [],
        });
      }
      if (path === "/api/vincent/status") {
        return jsonResponse({ connected: true, connectedAt: 1 });
      }
      if (path === "/api/vincent/strategy") {
        return jsonResponse({
          connected: true,
          strategy: {
            name: "balanced",
            running: true,
            tradingVenues: ["hyperliquid", "polymarket"],
          },
        });
      }
      return jsonResponse(null);
    });
    vi.stubGlobal("fetch", fetchMock);

    const runtime = {
      agentId: AGENT_ID,
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-wallet"),
      })),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );

    expect(result.text).toContain("Wallet view");
    expect(result.text).toContain("Live wallet state:");
    expect(result.text).toContain("0x1234...abcd");
    expect(result.text).toContain("RPC providers");
    expect(result.text).toContain("EVM token inventory");
    expect(result.text).toContain("24h activity: 1 swap");
    expect(result.text).toContain("Vincent: connected");
  });

  it("includes a substantive main-chat tail when sourceConversationId points to one", async () => {
    const sourceConversationId = "main-1";
    const sourceRoomId = stringToUuid(`web-conv-${sourceConversationId}`);
    const now = Date.now();
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-character", {
          sourceConversationId,
        }),
      })),
      getMemories: vi.fn(async ({ roomId }: { roomId: UUID }) => {
        if (roomId !== sourceRoomId) return [];
        return [
          {
            id: "m1",
            roomId,
            entityId: "user-1" as UUID,
            content: { text: "I want a calmer character" },
            createdAt: now - 60_000,
          },
          {
            id: "m2",
            roomId,
            entityId: AGENT_ID,
            content: { text: "Got it — I'll soften the bio." },
            createdAt: now - 30_000,
          },
        ];
      }),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );
    expect(result.text).toContain("Recent main-chat tail:");
    expect(result.text).toContain("I want a calmer character");
    expect(result.text).toContain("I'll soften the bio.");
    expect(result.values?.sourceTailIncluded).toBe(true);
  });

  it("ignores a blank main chat (no messages)", async () => {
    const sourceConversationId = "main-blank";
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-character", {
          sourceConversationId,
        }),
      })),
      getMemories: vi.fn(async () => []),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );
    expect(result.text).not.toContain("Recent main-chat tail:");
    expect(result.values?.sourceTailIncluded).toBe(false);
  });

  it("ignores an agent-only initiated main chat (assistant talked, user never replied)", async () => {
    const sourceConversationId = "main-agent-only";
    const sourceRoomId = stringToUuid(`web-conv-${sourceConversationId}`);
    const now = Date.now();
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-character", {
          sourceConversationId,
        }),
      })),
      getMemories: vi.fn(async ({ roomId }: { roomId: UUID }) =>
        roomId === sourceRoomId
          ? [
              {
                id: "m1",
                roomId,
                entityId: AGENT_ID,
                content: { text: "Hey, want to plan your day?" },
                createdAt: now - 60_000,
              },
            ]
          : [],
      ),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );
    expect(result.text).not.toContain("Recent main-chat tail:");
    expect(result.values?.sourceTailIncluded).toBe(false);
  });

  it("ignores a stale main chat (last user message older than 24h)", async () => {
    const sourceConversationId = "main-stale";
    const sourceRoomId = stringToUuid(`web-conv-${sourceConversationId}`);
    const now = Date.now();
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      getRoom: vi.fn(async () => ({
        id: "room-1",
        metadata: pageRoomMetadata("page-character", {
          sourceConversationId,
        }),
      })),
      getMemories: vi.fn(async ({ roomId }: { roomId: UUID }) =>
        roomId === sourceRoomId
          ? [
              {
                id: "m1",
                roomId,
                entityId: "user-1" as UUID,
                content: { text: "old user msg" },
                createdAt: now - 25 * 60 * 60 * 1000,
              },
              {
                id: "m2",
                roomId,
                entityId: AGENT_ID,
                content: { text: "old agent reply" },
                createdAt: now - 25 * 60 * 60 * 1000 + 60_000,
              },
            ]
          : [],
      ),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage(),
      {} as never,
    );
    expect(result.text).not.toContain("Recent main-chat tail:");
    expect(result.values?.sourceTailIncluded).toBe(false);
  });

  it("does not bridge if sourceConversationId points to its own room", async () => {
    const _ownRoomId = stringToUuid("self") as UUID;
    const ownConversationId = "self";
    // construct sourceRoomId that equals ownRoomId
    // sourceRoomId formula: stringToUuid(`web-conv-${id}`)
    // To force collision, set sourceConversationId such that the formula matches ownRoomId.
    // Easiest: manually set ownRoomId to that UUID.
    const sourceConversationId = "x";
    const collidingRoomId = stringToUuid(
      `web-conv-${sourceConversationId}`,
    ) as UUID;
    const runtime = {
      agentId: AGENT_ID,
      character: { name: "Eliza" },
      getRoom: vi.fn(async () => ({
        id: collidingRoomId,
        metadata: pageRoomMetadata("page-character", {
          sourceConversationId,
        }),
      })),
      getMemories: vi.fn(),
    };
    const result = await pageScopedContextProvider.get(
      runtime as never,
      buildMessage({ roomId: collidingRoomId }),
      {} as never,
    );
    expect(result.values?.sourceTailIncluded).toBe(false);
    expect(runtime.getMemories).not.toHaveBeenCalled();
    // ownConversationId param above is unused — the colliding case relies on the runtime's roomId.
    expect(ownConversationId).toBe("self");
  });
});

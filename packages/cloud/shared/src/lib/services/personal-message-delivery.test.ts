/**
 * Exercises normalized personal connector delivery with mocked runtime edges,
 * proving Shared fallback and active Dedicated selection.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

let dedicatedTarget: { id: string; status: "running"; bridge_url: string } | null = null;
const findActivePersonalDedicatedTarget = mock(async () => dedicatedTarget);
const preparePersonalDedicatedDelivery = mock(async () => ({ state: "ready" as const }));
const sharedRestMessageSend = mock(async () => ({ text: "Shared reply", agentName: "Eliza" }));
const bridge = mock(async () => ({ result: { text: "Dedicated reply" } }));
const coordinateSharedHistory = mock(async () => [] as Array<Record<string, unknown>>);
const importCanonicalConversation = mock(
  async () =>
    null as null | {
      complete: true;
      sourceMessageCount: number;
      inserted: number;
      skipped: number;
    },
);

mock.module("./agent-tier-upgrade-target", () => ({ findActivePersonalDedicatedTarget }));
mock.module("./personal-dedicated-delivery", () => ({ preparePersonalDedicatedDelivery }));
mock.module("./shared-runtime/personal-shared-agent", () => ({
  personalSharedAgent: () => ({
    id: "personal-shared-agent",
    agent_name: "Eliza",
  }),
}));
mock.module("./shared-runtime/shared-rest-adapter", () => ({ sharedRestMessageSend }));
mock.module("./shared-runtime/conversation-coordinator", () => ({
  coordinateSharedHistory,
}));
mock.module("./eliza-sandbox", () => ({
  elizaSandboxService: {
    bridge,
    importCanonicalConversation,
  },
}));

const { deliverPersonalTextMessage } = await import("./personal-message-delivery");

const base = {
  account: {
    user: { id: "personal-user" },
    organization: { id: "personal-org" },
  },
  message: "hello",
  messageId: "x-dm:501",
  platform: "x",
  senderName: "Alice",
  env: {},
  executionCtx: { waitUntil: mock() },
  namespace: { getByName: mock(() => ({ fetch: mock() })) },
} as never;

describe("deliverPersonalTextMessage", () => {
  beforeEach(() => {
    dedicatedTarget = null;
    sharedRestMessageSend.mockClear();
    bridge.mockClear();
    coordinateSharedHistory.mockClear();
    importCanonicalConversation.mockClear();
  });

  test("uses the rowless personal Shared runtime when no Dedicated target exists", async () => {
    const result = await deliverPersonalTextMessage(base);

    expect(result).toMatchObject({
      success: true,
      identity: { id: "personal-shared-agent", runtime: "shared" },
      reply: "Shared reply",
    });
    expect(sharedRestMessageSend).toHaveBeenCalledTimes(1);
    expect(bridge).not.toHaveBeenCalled();
  });

  test("uses the active personal Dedicated runtime when present", async () => {
    dedicatedTarget = {
      id: "dedicated-agent",
      status: "running",
      bridge_url: "https://dedicated.example.test",
    };
    const result = await deliverPersonalTextMessage(base);

    expect(result).toMatchObject({
      success: true,
      identity: {
        id: "personal-shared-agent",
        runtime: "dedicated",
        activeAgentId: "dedicated-agent",
      },
      reply: "Dedicated reply",
    });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(sharedRestMessageSend).not.toHaveBeenCalled();
  });

  test("preserves bounded grounding when repairing a Dedicated conversation", async () => {
    dedicatedTarget = {
      id: "dedicated-agent",
      status: "running",
      bridge_url: "https://dedicated.example.test",
    };
    bridge
      .mockImplementationOnce(async () => ({
        error: { message: "Bridge returned HTTP 404" },
      }))
      .mockImplementationOnce(async () => ({ result: { text: "Repaired reply" } }));
    coordinateSharedHistory.mockResolvedValueOnce([
      {
        id: "assistant-1",
        role: "assistant",
        content: "Current answer",
        createdAt: 123,
        grounding: {
          kind: "web_search",
          query: "current release",
          provider: "parallel",
          text: "released today",
          observedAt: 122,
          truncated: false,
        },
      },
    ]);
    importCanonicalConversation.mockResolvedValueOnce({
      complete: true,
      sourceMessageCount: 1,
      inserted: 1,
      skipped: 0,
    });

    const result = await deliverPersonalTextMessage(base);

    expect(result).toMatchObject({ success: true, reply: "Repaired reply" });
    expect(importCanonicalConversation).toHaveBeenCalledWith(
      "dedicated-agent",
      "personal-org",
      "personal-shared-agent",
      [
        {
          sourceId: "assistant-1",
          role: "assistant",
          text: "Current answer",
          timestamp: 123,
          grounding: {
            kind: "web_search",
            query: "current release",
            provider: "parallel",
            text: "released today",
            observedAt: 122,
            truncated: false,
          },
        },
      ],
    );
    expect(bridge).toHaveBeenCalledTimes(2);
  });
});

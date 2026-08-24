import { describe, expect, it, vi } from "vitest";

const routeAutonomyTextToUser = vi.fn(
  async (_state: unknown, _text: string, _source: string) => undefined,
);
vi.mock("../server-helpers-swarm.ts", () => ({
  routeAutonomyTextToUser: (state: unknown, text: string, source: string) =>
    routeAutonomyTextToUser(state, text, source),
}));

import { stringToUuid } from "@elizaos/core";
import type { AgentEventPayloadLike } from "../../runtime/agent-event-service.ts";
import {
  isLifeOpsCloudPluginRoute,
  maybeRouteAutonomyEventToConversation,
} from "../server-autonomy-helpers.ts";
import { createServerState } from "../server-state.ts";

describe("isLifeOpsCloudPluginRoute", () => {
  it("matches cloud plugin routes", () => {
    expect(isLifeOpsCloudPluginRoute("/api/cloud/features")).toBe(true);
    expect(isLifeOpsCloudPluginRoute("/api/cloud/features/sync")).toBe(true);
    expect(isLifeOpsCloudPluginRoute("/api/cloud/travel-providers/abc")).toBe(
      true,
    );
  });

  it("rejects unrelated paths", () => {
    expect(isLifeOpsCloudPluginRoute("/api/agents")).toBe(false);
    expect(isLifeOpsCloudPluginRoute("/")).toBe(false);
  });
});

describe("maybeRouteAutonomyEventToConversation", () => {
  const state = { conversations: new Map() } as never;

  it("ignores non-assistant streams", async () => {
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "user",
    } as never);
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("ignores empty or missing text", async () => {
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      data: {},
    } as never);
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("drops client-chat echoes", async () => {
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      data: { text: "hi", source: "client_chat" },
    } as never);
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("routes autonomy text without explicit source when roomId exists", async () => {
    routeAutonomyTextToUser.mockClear();
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      roomId: "r1",
      data: { text: "hi" },
    } as never);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(
      state,
      "hi",
      "autonomy",
    );
  });

  it("drops events whose room already has an open conversation", async () => {
    routeAutonomyTextToUser.mockClear();
    const busyState = {
      conversations: new Map([["c1", { roomId: "r1" }]]),
    } as never;
    await maybeRouteAutonomyEventToConversation(busyState, {
      stream: "assistant",
      roomId: "r1",
      data: { text: "hi" },
    } as never);
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });
});

describe("isLifeOpsCloudPluginRoute boundaries", () => {
  it("matches the travel-providers prefix with an empty suffix", () => {
    expect(isLifeOpsCloudPluginRoute("/api/cloud/travel-providers/")).toBe(
      true,
    );
  });

  it("rejects travel-providers without the trailing slash", () => {
    expect(isLifeOpsCloudPluginRoute("/api/cloud/travel-providers")).toBe(
      false,
    );
  });

  it("rejects feature descendants and near-miss prefixes", () => {
    expect(isLifeOpsCloudPluginRoute("/api/cloud/features/extra")).toBe(false);
    expect(isLifeOpsCloudPluginRoute("/api/cloud/features-sync")).toBe(false);
  });

  it("rejects case-varied, embedded, query-suffixed, and empty paths", () => {
    expect(isLifeOpsCloudPluginRoute("/API/CLOUD/FEATURES")).toBe(false);
    expect(isLifeOpsCloudPluginRoute("/x/api/cloud/features")).toBe(false);
    expect(isLifeOpsCloudPluginRoute("/api/cloud/features?sync=1")).toBe(false);
    expect(isLifeOpsCloudPluginRoute("")).toBe(false);
  });
});

describe("maybeRouteAutonomyEventToConversation source handling", () => {
  function makeState() {
    return createServerState({
      config: {},
      plugins: [],
      deletedConversationIds: new Set<string>(),
      resolveAgentName: () => "Eliza",
      detectRuntimeModel: () => undefined,
      resolveAgentAutomationMode: () => "connectors-only",
      resolveTradePermissionMode: () => "user-sign-only",
    });
  }

  function makeEvent(
    overrides: Partial<AgentEventPayloadLike> = {},
  ): AgentEventPayloadLike {
    return {
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: 1,
      data: {},
      ...overrides,
    };
  }

  function makeEventWithInvalidData(data: unknown): AgentEventPayloadLike {
    return makeEvent({ data: data as AgentEventPayloadLike["data"] });
  }

  function addConversation(
    state: ReturnType<typeof makeState>,
    id: string,
    roomLabel: string,
  ): void {
    const timestamp = "2026-08-24T00:00:00.000Z";
    state.conversations.set(id, {
      id,
      title: "Test conversation",
      roomId: stringToUuid(roomLabel),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  it("preserves leading and trailing whitespace with an explicit source", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = makeState();
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEvent({ data: { text: " hello ", source: " custom " } }),
    );
    expect(routeAutonomyTextToUser).toHaveBeenCalledTimes(1);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(
      state,
      " hello ",
      "custom",
    );
  });

  it("preserves multiline text including indentation and final whitespace", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = makeState();
    const text = "\nfirst line\n  indented line  \n";
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEvent({ data: { text, source: "custom" } }),
    );
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(state, text, "custom");
  });

  it("falls back to autonomy for whitespace-only sources with a room", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = makeState();
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEvent({
        roomId: stringToUuid("room-whitespace-source"),
        data: { text: "hi", source: "   " },
      }),
    );
    expect(routeAutonomyTextToUser).toHaveBeenCalledTimes(1);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(
      state,
      "hi",
      "autonomy",
    );
  });

  it("drops events whose only source is whitespace and which lack a room", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = makeState();
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEvent({ data: { text: "hi", source: "   " } }),
    );
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only text", async () => {
    routeAutonomyTextToUser.mockClear();
    await maybeRouteAutonomyEventToConversation(
      makeState(),
      makeEvent({ data: { text: "   " } }),
    );
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("ignores non-string text values", async () => {
    routeAutonomyTextToUser.mockClear();
    await maybeRouteAutonomyEventToConversation(
      makeState(),
      makeEvent({ data: { text: 42 } }),
    );
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("ignores null, primitive, and array payload data", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = makeState();
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEventWithInvalidData(null),
    );
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEventWithInvalidData("boom"),
    );
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEventWithInvalidData([{ text: "hi" }]),
    );
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("still drops client-chat echoes padded with whitespace", async () => {
    routeAutonomyTextToUser.mockClear();
    await maybeRouteAutonomyEventToConversation(
      makeState(),
      makeEvent({
        data: { text: "hi", source: " client_chat " },
      }),
    );
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("routes when only a different room is already open", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = makeState();
    addConversation(state, "c1", "other-room");
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEvent({
        roomId: stringToUuid("target-room"),
        data: { text: "hi", source: "custom" },
      }),
    );
    expect(routeAutonomyTextToUser).toHaveBeenCalledTimes(1);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(state, "hi", "custom");
  });

  it("skips the busy-room scan when the typed event has no roomId", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = makeState();
    addConversation(state, "c1", "unrelated-room");
    await maybeRouteAutonomyEventToConversation(
      state,
      makeEvent({ data: { text: "hi", source: "custom" } }),
    );
    expect(routeAutonomyTextToUser).toHaveBeenCalledTimes(1);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(state, "hi", "custom");
  });

  it("propagates routeAutonomyTextToUser rejections", async () => {
    routeAutonomyTextToUser.mockClear();
    routeAutonomyTextToUser.mockRejectedValueOnce(new Error("swarm down"));
    const state = makeState();
    await expect(
      maybeRouteAutonomyEventToConversation(
        state,
        makeEvent({ data: { text: "hi", source: "custom" } }),
      ),
    ).rejects.toThrow("swarm down");
  });
});

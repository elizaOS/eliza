import { describe, expect, it, vi } from "vitest";

const routeAutonomyTextToUser = vi.fn(
  async (_state: unknown, _text: string, _source: string) => undefined,
);
vi.mock("../server-helpers-swarm.ts", () => ({
  routeAutonomyTextToUser: (state: unknown, text: string, source: string) =>
    routeAutonomyTextToUser(state, text, source),
}));

import {
  isLifeOpsCloudPluginRoute,
  maybeRouteAutonomyEventToConversation,
} from "../server-autonomy-helpers.ts";

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
  it("routes a trimmed explicit source even when no roomId exists", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = { conversations: new Map() } as never;
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      data: { text: " hello ", source: " custom " },
    } as never);
    expect(routeAutonomyTextToUser).toHaveBeenCalledTimes(1);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(
      state,
      "hello",
      "custom",
    );
  });

  it("falls back to autonomy for whitespace-only sources with a room", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = { conversations: new Map() } as never;
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      roomId: "r-ws",
      data: { text: "hi", source: "   " },
    } as never);
    expect(routeAutonomyTextToUser).toHaveBeenCalledTimes(1);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(
      state,
      "hi",
      "autonomy",
    );
  });

  it("drops events whose only source is whitespace and which lack a room", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = { conversations: new Map() } as never;
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      data: { text: "hi", source: "   " },
    } as never);
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("ignores whitespace-only text", async () => {
    routeAutonomyTextToUser.mockClear();
    await maybeRouteAutonomyEventToConversation(
      { conversations: new Map() } as never,
      { stream: "assistant", data: { text: "   " } } as never,
    );
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("ignores non-string text values", async () => {
    routeAutonomyTextToUser.mockClear();
    await maybeRouteAutonomyEventToConversation(
      { conversations: new Map() } as never,
      { stream: "assistant", data: { text: 42 } } as never,
    );
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("ignores null, primitive, and array payload data", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = { conversations: new Map() } as never;
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      data: null,
    } as never);
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      data: "boom",
    } as never);
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      data: [{ text: "hi" }],
    } as never);
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("still drops client-chat echoes padded with whitespace", async () => {
    routeAutonomyTextToUser.mockClear();
    await maybeRouteAutonomyEventToConversation(
      { conversations: new Map() } as never,
      {
        stream: "assistant",
        data: { text: "hi", source: " client_chat " },
      } as never,
    );
    expect(routeAutonomyTextToUser).not.toHaveBeenCalled();
  });

  it("routes when only a different room is already open", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = {
      conversations: new Map([["c1", { roomId: "other" }]]),
    } as never;
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      roomId: "r1",
      data: { text: "hi", source: "custom" },
    } as never);
    expect(routeAutonomyTextToUser).toHaveBeenCalledTimes(1);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(state, "hi", "custom");
  });

  it("skips the busy-room scan when roomId is an empty string", async () => {
    routeAutonomyTextToUser.mockClear();
    const state = {
      conversations: new Map([["c1", { roomId: "" }]]),
    } as never;
    await maybeRouteAutonomyEventToConversation(state, {
      stream: "assistant",
      roomId: "",
      data: { text: "hi", source: "custom" },
    } as never);
    expect(routeAutonomyTextToUser).toHaveBeenCalledTimes(1);
    expect(routeAutonomyTextToUser).toHaveBeenCalledWith(state, "hi", "custom");
  });

  it("propagates routeAutonomyTextToUser rejections", async () => {
    routeAutonomyTextToUser.mockClear();
    routeAutonomyTextToUser.mockRejectedValueOnce(new Error("swarm down"));
    const state = { conversations: new Map() } as never;
    await expect(
      maybeRouteAutonomyEventToConversation(state, {
        stream: "assistant",
        data: { text: "hi", source: "custom" },
      } as never),
    ).rejects.toThrow("swarm down");
  });
});

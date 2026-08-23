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

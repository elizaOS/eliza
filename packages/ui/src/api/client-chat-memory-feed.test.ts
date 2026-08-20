/**
 * Verifies the typed memory-feed client carries the complete stable cursor to
 * the real request transport without relying on a live agent.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import "./client-chat";

describe("memory feed client cursor", () => {
  it("serializes both timestamp and id tie-breaker", async () => {
    const urls: string[] = [];
    const client = new ElizaClient("http://agent.example:31337");
    client.setRequestTransport({
      request: async (url) => {
        urls.push(url);
        return new Response(
          JSON.stringify({
            memories: [],
            count: 0,
            limit: 50,
            hasMore: false,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    });

    await client.getMemoryFeed({
      type: "messages",
      limit: 50,
      before: 200,
      beforeId: "00000000-0000-4000-8000-000000000123",
    });

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/api/memories/feed");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      type: "messages",
      limit: "50",
      before: "200",
      beforeId: "00000000-0000-4000-8000-000000000123",
    });
  });
});

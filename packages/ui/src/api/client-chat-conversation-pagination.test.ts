/**
 * Verifies conversation-history requests preserve the complete keyset cursor
 * through the real HTTP client transport.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import "./client-chat";

describe("conversation message client cursor", () => {
  it("serializes both timestamp and id tiebreaker", async () => {
    const urls: string[] = [];
    const client = new ElizaClient("http://agent.example:31337");
    client.setRequestTransport({
      request: async (url) => {
        urls.push(url);
        return new Response(JSON.stringify({ messages: [], hasMore: false }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    await client.getConversationMessages("conversation-1", {
      before: 4000,
      beforeId: "00000000-0000-0000-0000-000000000002",
      limit: 50,
    });

    expect(urls).toHaveLength(1);
    const url = new URL(urls[0] ?? "");
    expect(url.pathname).toBe("/api/conversations/conversation-1/messages");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      before: "4000",
      beforeId: "00000000-0000-0000-0000-000000000002",
      limit: "50",
    });
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" },
  CapacitorHttp: { get: vi.fn(), post: vi.fn(), request: vi.fn() },
}));

import { ElizaClient } from "./client-base";
import "./client-chat";

/**
 * A serverless / shared-runtime Cloud agent returns conversation objects
 * WITHOUT `updatedAt` (`{id,title,roomId,createdAt}`). The shared
 * `isConversationRecord` guard requires `updatedAt`, so without boundary
 * normalization the conversation list filters to empty and chat sends are
 * dropped (no active conversation, and createConversation's result is rejected).
 * The client defaults `updatedAt` to `createdAt` at the API boundary.
 */
function jsonTransport(body: unknown) {
  return {
    request: async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  };
}

const BASE = "https://api.elizacloud.ai/api/v1/eliza/agents/agent-1";
const CREATED = "2026-06-18T00:00:00.000Z";

describe("conversation updatedAt boundary normalization", () => {
  it("createConversation defaults updatedAt to createdAt when the server omits it", async () => {
    const client = new ElizaClient(BASE);
    client.setRequestTransport(
      jsonTransport({
        conversation: {
          id: "c1",
          title: "Chat",
          roomId: "c1",
          createdAt: CREATED,
        },
      }),
    );
    const res = await client.createConversation();
    expect(res.conversation.updatedAt).toBe(CREATED);
  });

  it("listConversations defaults updatedAt for each item", async () => {
    const client = new ElizaClient(BASE);
    client.setRequestTransport(
      jsonTransport({
        conversations: [
          { id: "c1", title: "Chat", roomId: "c1", createdAt: CREATED },
        ],
      }),
    );
    const res = await client.listConversations();
    expect(res.conversations[0]?.updatedAt).toBe(CREATED);
  });

  it("preserves a server-provided updatedAt (no clobber)", async () => {
    const client = new ElizaClient(BASE);
    const updated = "2026-06-19T12:00:00.000Z";
    client.setRequestTransport(
      jsonTransport({
        conversation: {
          id: "c1",
          title: "Chat",
          roomId: "c1",
          createdAt: CREATED,
          updatedAt: updated,
        },
      }),
    );
    const res = await client.createConversation();
    expect(res.conversation.updatedAt).toBe(updated);
  });
});

/** Exercises BlueBubbles pagination validation through the route harness. */
import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleBlueBubblesRoute } from "./bluebubbles-routes.ts";

interface ListCall {
  kind: "chats" | "messages";
  limit?: number;
  offset?: number;
  chatGuid?: string;
}

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return { json, error, readJsonBody } as unknown as RouteHelpers & {
    json: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

async function call(
  url: string,
  pathname: string,
  calls: ListCall[]
): Promise<{ helpers: ReturnType<typeof makeHelpers> }> {
  const helpers = makeHelpers();
  const client = {
    listChats: async (limit?: number, offset?: number) => {
      calls.push({ kind: "chats", limit, offset });
      return [{ id: "chat-1" }];
    },
    getMessages: async (chatGuid: string, limit?: number, offset?: number) => {
      calls.push({ kind: "messages", chatGuid, limit, offset });
      return [{ id: "msg-1" }];
    },
  };
  const state = {
    runtime: {
      getService: (type: string) =>
        type === "bluebubbles"
          ? {
              isConnected: () => true,
              getWebhookPath: () => "/webhooks/bluebubbles",
              getClient: () => client,
              handleWebhook: async () => undefined,
            }
          : null,
    },
  };
  const req = { url } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const handled = await handleBlueBubblesRoute(req, res, pathname, "GET", state, helpers);
  expect(handled).toBe(true);
  return { helpers };
}

describe("GET /api/bluebubbles/chats limit identity", () => {
  it("omitted limit defaults to 100 and reaches listChats", async () => {
    const calls: ListCall[] = [];
    const { helpers } = await call("/api/bluebubbles/chats", "/api/bluebubbles/chats", calls);
    expect(helpers.error).not.toHaveBeenCalled();
    expect(calls).toEqual([{ kind: "chats", limit: 100, offset: 0 }]);
  });

  it("accepts canonical limit=10", async () => {
    const calls: ListCall[] = [];
    const { helpers } = await call(
      "/api/bluebubbles/chats?limit=10",
      "/api/bluebubbles/chats",
      calls
    );
    expect(helpers.error).not.toHaveBeenCalled();
    expect(calls).toEqual([{ kind: "chats", limit: 10, offset: 0 }]);
  });

  it("caps a canonical oversize limit at 500", async () => {
    const calls: ListCall[] = [];
    await call("/api/bluebubbles/chats?limit=501", "/api/bluebubbles/chats", calls);
    expect(calls).toEqual([{ kind: "chats", limit: 500, offset: 0 }]);
  });

  it.each(["1e2", "12px", "007", "0", "abc", "-1", "50abc", " 10", "10 "])(
    "rejects prefix-coerced chats limit=%s before listChats",
    async (token) => {
      const calls: ListCall[] = [];
      const { helpers } = await call(
        `/api/bluebubbles/chats?limit=${encodeURIComponent(token)}`,
        "/api/bluebubbles/chats",
        calls
      );
      expect(helpers.error).toHaveBeenCalledWith(
        expect.anything(),
        "limit must be a positive integer",
        400
      );
      expect(calls).toEqual([]);
    }
  );

  it.each(["1e2", "12px", "007", "-1", "0x10"])(
    "rejects prefix-coerced chats offset=%s before listChats",
    async (token) => {
      const calls: ListCall[] = [];
      const { helpers } = await call(
        `/api/bluebubbles/chats?offset=${encodeURIComponent(token)}`,
        "/api/bluebubbles/chats",
        calls
      );
      expect(helpers.error).toHaveBeenCalledWith(
        expect.anything(),
        "offset must be a non-negative integer",
        400
      );
      expect(calls).toEqual([]);
    }
  );
});

describe("GET /api/bluebubbles/messages limit identity", () => {
  it("omitted limit defaults to 50 and reaches getMessages", async () => {
    const calls: ListCall[] = [];
    const { helpers } = await call(
      "/api/bluebubbles/messages?chatGuid=chat-1",
      "/api/bluebubbles/messages",
      calls
    );
    expect(helpers.error).not.toHaveBeenCalled();
    expect(calls).toEqual([{ kind: "messages", chatGuid: "chat-1", limit: 50, offset: 0 }]);
  });

  it.each(["1e2", "12px", "007", "0", "foo"])(
    "rejects prefix-coerced messages limit=%s before getMessages",
    async (token) => {
      const calls: ListCall[] = [];
      const { helpers } = await call(
        `/api/bluebubbles/messages?chatGuid=chat-1&limit=${encodeURIComponent(token)}`,
        "/api/bluebubbles/messages",
        calls
      );
      expect(helpers.error).toHaveBeenCalledWith(
        expect.anything(),
        "limit must be a positive integer",
        400
      );
      expect(calls).toEqual([]);
    }
  );
});

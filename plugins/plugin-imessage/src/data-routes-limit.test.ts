/**
 * GET /api/imessage/messages?limit= must reject prefix-coerced tokens before
 * the iMessage service is called. Number.parseInt("1e2", 10) === 1 used to
 * silently return one row.
 */
import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  buildSetupError: (code: string, message: string) => ({
    error: { code, message },
  }),
}));

import { imessageDataRoutes } from "./data-routes.ts";

const messagesRoute = imessageDataRoutes.find(
  (route) => route.type === "GET" && route.path === "/api/imessage/messages"
);

if (!messagesRoute?.handler) {
  throw new Error("GET /api/imessage/messages handler missing");
}

interface MessageQuery {
  chatId?: string;
  limit?: number;
}

interface Captured {
  status?: number;
  body?: unknown;
}

function mockRes(captured: Captured): RouteResponse {
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(data: unknown) {
      captured.body = data;
      return res;
    },
    send(data: unknown) {
      captured.body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  return res;
}

async function getMessages(url: string, queries: MessageQuery[]): Promise<Captured> {
  const captured: Captured = {};
  const runtime = {
    getService: (key: string) => {
      if (key !== "imessage") return null;
      return {
        isConnected: () => true,
        getMessages: async (opts?: { chatId?: string; limit?: number }) => {
          queries.push({ chatId: opts?.chatId, limit: opts?.limit });
          return [{ id: "1", text: "hi" }];
        },
        getRecentMessages: async (limit?: number) => {
          queries.push({ limit });
          return [{ id: "1", text: "hi" }];
        },
        sendMessage: async () => ({ success: true }),
        getChats: async () => [],
        listAllContacts: async () => [],
        addContact: async () => "person-1",
        updateContact: async () => true,
        deleteContact: async () => true,
      };
    },
  } as unknown as IAgentRuntime;
  await messagesRoute.handler?.({ url, method: "GET" } as RouteRequest, mockRes(captured), runtime);
  return captured;
}

describe("GET /api/imessage/messages limit query", () => {
  it("canonical limit=10 reaches getMessages", async () => {
    const queries: MessageQuery[] = [];
    const captured = await getMessages("/api/imessage/messages?limit=10", queries);
    expect(captured.status).toBe(200);
    expect(queries).toEqual([{ chatId: undefined, limit: 10 }]);
  });

  it("omitted limit still defaults to 50", async () => {
    const queries: MessageQuery[] = [];
    const captured = await getMessages("/api/imessage/messages", queries);
    expect(captured.status).toBe(200);
    expect(queries).toEqual([{ chatId: undefined, limit: 50 }]);
  });

  it("caps a canonical oversize limit at 500", async () => {
    const queries: MessageQuery[] = [];
    const captured = await getMessages("/api/imessage/messages?limit=501", queries);
    expect(captured.status).toBe(200);
    expect(queries).toEqual([{ chatId: undefined, limit: 500 }]);
  });

  it.each(["1e2", "12px", "007", "0", "abc", "-1", "50abc", " 10", "10 ", " "])(
    "rejects prefix-coerced limit=%s with 400 before the service",
    async (limit) => {
      const queries: MessageQuery[] = [];
      const captured = await getMessages(
        `/api/imessage/messages?limit=${encodeURIComponent(limit)}`,
        queries
      );
      expect(captured.status).toBe(400);
      expect(captured.body).toEqual({
        error: {
          code: "bad_request",
          message: "limit must be a positive integer",
        },
      });
      expect(queries).toEqual([]);
    }
  );
});

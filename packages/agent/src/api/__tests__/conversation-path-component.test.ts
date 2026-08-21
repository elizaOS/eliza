/**
 * Exercises every conversation-route path decoder through the production
 * handler. Malformed encodings must commit a static 400 before conversation,
 * body, or runtime work; valid encodings are decoded exactly once.
 */
import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  type ConversationRouteContext,
  type ConversationRouteState,
  handleConversationRoutes,
} from "../conversation-routes.ts";

const MALFORMED_COMPONENTS = [
  "%",
  "%2",
  "%ZZ",
  "%E0%A4",
  "%ED%A0%80",
  "%C0%80",
] as const;

const ROUTES = [
  {
    label: "message list conversation id",
    method: "GET",
    path: (value: string) => `/api/conversations/${value}/messages`,
    field: "conversation id",
  },
  {
    label: "import conversation id",
    method: "POST",
    path: (value: string) => `/api/conversations/${value}/import`,
    field: "conversation id",
  },
  {
    label: "truncate conversation id",
    method: "POST",
    path: (value: string) => `/api/conversations/${value}/messages/truncate`,
    field: "conversation id",
  },
  {
    label: "single-message delete conversation id",
    method: "DELETE",
    path: (value: string) => `/api/conversations/${value}/messages/message-id`,
    field: "conversation id",
  },
  {
    label: "single-message delete message id",
    method: "DELETE",
    path: (value: string) => `/api/conversations/%61/messages/${value}`,
    field: "conversation message id",
  },
  {
    label: "stream conversation id",
    method: "POST",
    path: (value: string) => `/api/conversations/${value}/messages/stream`,
    field: "conversation id",
  },
  {
    label: "message-create conversation id",
    method: "POST",
    path: (value: string) => `/api/conversations/${value}/messages`,
    field: "conversation id",
  },
  {
    label: "greeting conversation id",
    method: "POST",
    path: (value: string) => `/api/conversations/${value}/greeting`,
    field: "conversation id",
  },
  {
    label: "patch conversation id",
    method: "PATCH",
    path: (value: string) => `/api/conversations/${value}`,
    field: "conversation id",
  },
  {
    label: "delete conversation id",
    method: "DELETE",
    path: (value: string) => `/api/conversations/${value}`,
    field: "conversation id",
  },
] as const;

type RecordedResponse = http.ServerResponse & {
  body: string;
  headers: Record<string, string | number | readonly string[]>;
};

function responseRecorder(): RecordedResponse {
  return {
    statusCode: 200,
    body: "",
    headers: {},
    setHeader(
      this: RecordedResponse,
      name: string,
      value: string | number | readonly string[],
    ) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    end(this: RecordedResponse, chunk?: unknown) {
      if (chunk !== undefined) this.body += String(chunk);
      return this;
    },
  } as unknown as RecordedResponse;
}

function makeContext(
  method: string,
  pathname: string,
): {
  context: ConversationRouteContext;
  conversationsGet: ReturnType<typeof vi.fn>;
  readJsonBody: ReturnType<typeof vi.fn>;
  res: RecordedResponse;
} {
  const conversations = new Map();
  const conversationsGet = vi.spyOn(conversations, "get");
  const readJsonBody = vi.fn(async () => {
    throw new Error("request body must not be read before path validation");
  });
  const res = responseRecorder();
  const state = {
    runtime: null,
    config: {},
    agentName: "Path Decoder",
    adminEntityId: null,
    chatUserId: null,
    logBuffer: [],
    conversations,
    activeChatTurnCount: 0,
    conversationRestorePromise: null,
    deletedConversationIds: new Set<string>(),
    broadcastWs: null,
  } as unknown as ConversationRouteState;
  const context = {
    req: {
      url: pathname,
      headers: { host: "localhost" },
      socket: { remoteAddress: "127.0.0.1" },
    },
    res,
    method,
    pathname,
    readJsonBody,
    json: vi.fn(),
    error: vi.fn(),
    state,
  } as unknown as ConversationRouteContext;
  return { context, conversationsGet, readJsonBody, res };
}

describe("conversation route path-component decoding", () => {
  for (const route of ROUTES) {
    for (const malformed of MALFORMED_COMPONENTS) {
      it(`rejects ${route.label} ${malformed} before route work`, async () => {
        const pathname = route.path(malformed);
        const { context, conversationsGet, readJsonBody, res } = makeContext(
          route.method,
          pathname,
        );

        await expect(handleConversationRoutes(context)).resolves.toBe(true);

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body)).toEqual({
          error: `Invalid ${route.field}: malformed URL encoding`,
        });
        expect(conversationsGet).not.toHaveBeenCalled();
        expect(readJsonBody).not.toHaveBeenCalled();
      });
    }
  }

  it("decodes a valid conversation id once before lookup", async () => {
    const { context, conversationsGet, res } = makeContext(
      "GET",
      "/api/conversations/%61/messages",
    );

    await expect(handleConversationRoutes(context)).resolves.toBe(true);

    expect(conversationsGet).toHaveBeenCalledWith("a");
    expect(conversationsGet.mock.calls.every(([id]) => id === "a")).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it("does not decode an already encoded percent sequence twice", async () => {
    const { context, conversationsGet, res } = makeContext(
      "GET",
      "/api/conversations/%2561/messages",
    );

    await expect(handleConversationRoutes(context)).resolves.toBe(true);

    expect(conversationsGet).toHaveBeenCalledWith("%61");
    expect(conversationsGet.mock.calls.every(([id]) => id === "%61")).toBe(
      true,
    );
    expect(res.statusCode).toBe(200);
  });

  it("decodes an encoded slash only after route matching", async () => {
    const { context, conversationsGet, res } = makeContext(
      "GET",
      "/api/conversations/%2F/messages",
    );

    await expect(handleConversationRoutes(context)).resolves.toBe(true);

    expect(conversationsGet).toHaveBeenCalledWith("/");
    expect(conversationsGet.mock.calls.every(([id]) => id === "/")).toBe(true);
    expect(res.statusCode).toBe(200);
  });
});

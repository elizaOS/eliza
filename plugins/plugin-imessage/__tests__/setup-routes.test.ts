import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { imessageSetupRoutes } from "../src/setup-routes.js";

function findRoute(type: string, path: string) {
  const route = imessageSetupRoutes.find((entry) => entry.type === type && entry.path === path);
  if (!route) {
    throw new Error(`missing route ${type} ${path}`);
  }
  return route;
}

function makeResponse() {
  const state: {
    statusCode: number;
    body: unknown;
  } = {
    statusCode: 200,
    body: null,
  };

  const response = {
    status(code: number) {
      state.statusCode = code;
      return response;
    },
    json(payload: unknown) {
      state.body = payload;
      return response;
    },
  } satisfies Pick<RouteResponse, "status" | "json">;

  return {
    response: response as unknown as RouteResponse,
    state,
  };
}

function makeRuntime(service: unknown): IAgentRuntime {
  return {
    getService: vi.fn(() => service),
  } as unknown as IAgentRuntime;
}

describe("imessage setup routes", () => {
  it("GET /api/imessage/messages forwards chatId and limit to the service", async () => {
    const service = {
      getMessages: vi.fn().mockResolvedValue([
        {
          id: "12",
          text: "group hello",
          handle: "+15559999999",
          chatId: "iMessage;+;group-abc",
          timestamp: 1,
          isFromMe: false,
          hasAttachments: false,
        },
      ]),
      getRecentMessages: vi.fn(),
    };
    const route = findRoute("GET", "/api/imessage/messages");
    const { response, state } = makeResponse();

    await route.handler(
      {
        url: "/api/imessage/messages?chatId=iMessage%3B%2B%3Bgroup-abc&limit=25",
      } as RouteRequest,
      response,
      makeRuntime(service)
    );

    expect(service.getMessages).toHaveBeenCalledWith({
      chatId: "iMessage;+;group-abc",
      limit: 25,
    });
    expect(service.getRecentMessages).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      messages: [
        {
          id: "12",
          text: "group hello",
          handle: "+15559999999",
          chatId: "iMessage;+;group-abc",
          timestamp: 1,
          isFromMe: false,
          hasAttachments: false,
        },
      ],
      count: 1,
    });
  });

  it("POST /api/imessage/messages sends to chat_id targets when chatId is provided", async () => {
    const service = {
      sendMessage: vi.fn().mockResolvedValue({
        success: true,
        messageId: "msg-1",
        chatId: "chat_id:iMessage;+;group-abc",
      }),
    };
    const route = findRoute("POST", "/api/imessage/messages");
    const { response, state } = makeResponse();

    await route.handler(
      {
        body: {
          chatId: "iMessage;+;group-abc",
          text: "hello from eliza",
        },
      } as RouteRequest,
      response,
      makeRuntime(service)
    );

    expect(service.sendMessage).toHaveBeenCalledWith(
      "chat_id:iMessage;+;group-abc",
      "hello from eliza",
      {}
    );
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      success: true,
      messageId: "msg-1",
      chatId: "chat_id:iMessage;+;group-abc",
    });
  });

  it("POST /api/imessage/messages rejects requests with no target", async () => {
    const service = {
      sendMessage: vi.fn(),
    };
    const route = findRoute("POST", "/api/imessage/messages");
    const { response, state } = makeResponse();

    await route.handler(
      {
        body: {
          text: "hello",
        },
      } as RouteRequest,
      response,
      makeRuntime(service)
    );

    expect(service.sendMessage).not.toHaveBeenCalled();
    expect(state.statusCode).toBe(400);
    expect(state.body).toEqual({
      error: "either to or chatId is required",
    });
  });

  it("POST /api/imessage/messages accepts attachment-only sends", async () => {
    const service = {
      sendMessage: vi.fn().mockResolvedValue({
        success: true,
        messageId: "msg-2",
        chatId: "+15551234567",
      }),
    };
    const route = findRoute("POST", "/api/imessage/messages");
    const { response, state } = makeResponse();

    await route.handler(
      {
        body: {
          to: "+15551234567",
          mediaUrl: "/tmp/image.png",
        },
      } as RouteRequest,
      response,
      makeRuntime(service)
    );

    expect(service.sendMessage).toHaveBeenCalledWith("+15551234567", "", {
      mediaUrl: "/tmp/image.png",
    });
    expect(state.statusCode).toBe(200);
    expect(state.body).toEqual({
      success: true,
      messageId: "msg-2",
      chatId: "+15551234567",
    });
  });
});

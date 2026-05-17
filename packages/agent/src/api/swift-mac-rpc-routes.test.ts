import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleSwiftMacRPCRoutes } from "./swift-mac-rpc-routes";

type SwiftMacRPCContext = Parameters<typeof handleSwiftMacRPCRoutes>[0];

afterEach(() => {
  vi.restoreAllMocks();
});

function makeCtx(body: object) {
  const req = {
    headers: {
      host: "127.0.0.1:31337",
    },
  } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const readJsonBody: SwiftMacRPCContext["readJsonBody"] = async <
    T extends object,
  >() => body as T;
  const json = vi.fn<SwiftMacRPCContext["json"]>();
  const error = vi.fn<SwiftMacRPCContext["error"]>();
  const ctx: SwiftMacRPCContext = {
    req,
    res,
    method: "POST",
    pathname: "/api/swift/rpc",
    readJsonBody,
    json,
    error,
  };
  return {
    ctx,
    json,
    error,
  };
}

describe("handleSwiftMacRPCRoutes", () => {
  it("forwards static runtime methods through the Swift RPC envelope", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ready: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { ctx, json } = makeCtx({
      id: "rpc-1",
      method: "runtime.health",
    });

    await expect(handleSwiftMacRPCRoutes(ctx)).resolves.toBe(true);

    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall?.[0])).toBe("http://127.0.0.1:31337/api/health");
    expect(firstCall?.[1]?.method).toBe("GET");
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      {
        id: "rpc-1",
        ok: true,
        status: 200,
        result: { ready: true },
      },
      200,
    );
  });

  it("maps conversation send params to the existing conversation route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ text: "Hello Ada" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const { ctx, json } = makeCtx({
      method: "conversation.send",
      params: {
        conversationID: "conv-1",
        text: "Hello",
        source: "swift-macos",
        metadata: { userName: "Ada" },
      },
    });

    await expect(handleSwiftMacRPCRoutes(ctx)).resolves.toBe(true);

    const firstCall = fetchMock.mock.calls[0];
    expect(String(firstCall?.[0])).toBe(
      "http://127.0.0.1:31337/api/conversations/conv-1/messages",
    );
    expect(firstCall?.[1]?.method).toBe("POST");
    expect(requestBodyText(firstCall?.[1]?.body)).toBe(
      JSON.stringify({
        text: "Hello",
        channelType: "DM",
        source: "swift-macos",
        metadata: { userName: "Ada" },
      }),
    );
    expect(json.mock.calls[0]?.[1]).toMatchObject({
      ok: true,
      status: 200,
      result: { text: "Hello Ada" },
    });
  });

  it("rejects unknown Swift RPC methods before forwarding", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const { ctx, error } = makeCtx({
      method: "runtime.unknown",
    });

    await expect(handleSwiftMacRPCRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Swift RPC method is invalid",
      400,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function requestBodyText(body: BodyInit | null | undefined): string {
  return typeof body === "string" ? body : "";
}

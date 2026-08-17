/**
 * GET /api/imessage/messages `limit` is list pagination leftover tax after
 * data-routes messages limit (#20855) and bluebubbles list limit.
 * Stock develop treated `limit=1e2` as one row
 * (`Number.parseInt("1e2", 10) === 1`) instead of a 400. chats /
 * contacts / status parsers stay untouched.
 */
import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleIMessageRoute } from "./imessage-routes.ts";

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
  limits: number[],
): Promise<{ helpers: ReturnType<typeof makeHelpers> }> {
  const helpers = makeHelpers();
  const state = {
    runtime: {
      getService: (type: string) =>
        type === "imessage"
          ? {
              isConnected: () => true,
              getRecentMessages: async (limit?: number) => {
                if (typeof limit === "number") limits.push(limit);
                return [{ id: "msg-1", text: "hi", handle: "me", chatId: "c1" }];
              },
              getChats: async () => [],
            }
          : null,
    },
  };
  const req = { url } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const handled = await handleIMessageRoute(
    req,
    res,
    "/api/imessage/messages",
    "GET",
    state,
    helpers,
  );
  expect(handled).toBe(true);
  return { helpers };
}

describe("GET /api/imessage/messages limit identity", () => {
  it("omitted limit defaults to 50 and reaches getRecentMessages", async () => {
    const limits: number[] = [];
    const { helpers } = await call("/api/imessage/messages", limits);
    expect(helpers.error).not.toHaveBeenCalled();
    expect(limits).toEqual([50]);
  });

  it("accepts empty limit as the default 50 page size", async () => {
    const limits: number[] = [];
    const { helpers } = await call("/api/imessage/messages?limit=", limits);
    expect(helpers.error).not.toHaveBeenCalled();
    expect(limits).toEqual([50]);
  });

  it("accepts canonical limit=10", async () => {
    const limits: number[] = [];
    const { helpers } = await call("/api/imessage/messages?limit=10", limits);
    expect(helpers.error).not.toHaveBeenCalled();
    expect(limits).toEqual([10]);
  });

  it("caps a canonical oversize limit at 500", async () => {
    const limits: number[] = [];
    await call("/api/imessage/messages?limit=501", limits);
    expect(limits).toEqual([500]);
  });

  it.each(["1e2", "12px", "007", "0", "abc", "-1", "50abc", " 10", "10 ", "0x10"])(
    "rejects prefix-coerced messages limit=%s before getRecentMessages",
    async (token) => {
      const limits: number[] = [];
      const { helpers } = await call(
        `/api/imessage/messages?limit=${encodeURIComponent(token)}`,
        limits,
      );
      expect(helpers.error).toHaveBeenCalledWith(
        expect.anything(),
        "limit must be a positive integer",
        400,
      );
      expect(limits).toEqual([]);
    },
  );
});

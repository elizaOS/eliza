/**
 * Exercises legacy message-history pagination with a deterministic service and
 * route-helper spies.
 */
import type http from "node:http";
import type { RouteHelpers } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { handleIMessageRoute } from "./imessage-routes.js";

function makeHelpers() {
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn();
  return { json, error, readJsonBody } as unknown as RouteHelpers & {
    json: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

async function request(url: string, observedLimits: number[]) {
  const helpers = makeHelpers();
  const state = {
    runtime: {
      getService: () => ({
        isConnected: () => true,
        getRecentMessages: async (limit?: number) => {
          if (limit !== undefined) {
            observedLimits.push(limit);
          }
          return [];
        },
      }),
    },
  };
  const handled = await handleIMessageRoute(
    { url } as http.IncomingMessage,
    {} as http.ServerResponse,
    "/api/imessage/messages",
    "GET",
    state,
    helpers
  );
  expect(handled).toBe(true);
  return helpers;
}

describe("GET /api/imessage/messages limit", () => {
  it.each([
    ["/api/imessage/messages", 50],
    ["/api/imessage/messages?limit=", 50],
    ["/api/imessage/messages?limit=10", 10],
    ["/api/imessage/messages?limit=007", 7],
    ["/api/imessage/messages?limit=-1", 1],
    ["/api/imessage/messages?limit=501", 500],
  ])("maps %s to %i", async (url, expected) => {
    const observedLimits: number[] = [];
    const helpers = await request(url, observedLimits);

    expect(helpers.error).not.toHaveBeenCalled();
    expect(observedLimits).toEqual([expected]);
  });

  it.each(["1e2", "12px", "abc", "50abc", "0x10"])(
    "rejects malformed limit %s before reading messages",
    async (limit) => {
      const observedLimits: number[] = [];
      const helpers = await request(
        `/api/imessage/messages?limit=${encodeURIComponent(limit)}`,
        observedLimits
      );

      expect(helpers.error).toHaveBeenCalledWith(
        expect.anything(),
        "limit must be an integer",
        400
      );
      expect(observedLimits).toEqual([]);
    }
  );
});

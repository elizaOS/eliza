/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves getLifeOpsCalendarFeed carries timeoutMs into Agent.request.
 * Remaining calendar CRUD stays untouched. Not #21956. Query construction
 * unchanged (#21541).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "@elizaos/ui/api/client-base";
import type { AgentRequestTransport } from "@elizaos/ui/api/transport";
import { setBootConfig } from "@elizaos/ui/config/boot-config";
import {
  LIFEOPS_CALENDAR_FEED_FETCH_TIMEOUT_MS,
} from "./client-calendar";
import "./client-calendar";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("getLifeOpsCalendarFeed native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the feed deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ events: [] }),
    );
    await makeClient(request).getLifeOpsCalendarFeed();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/calendar/feed",
      expect.any(Object),
      { timeoutMs: LIFEOPS_CALENDAR_FEED_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled feed hop through ElizaClient", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        await new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              Object.assign(new Error(`Request timed out after ${ms}ms`), {
                name: "TimeoutError",
              }),
            );
          }, ms);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      },
    );
    await expect(
      makeClient(request).getLifeOpsCalendarFeed({}, 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/calendar/feed",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the feed hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("calendar feed unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      makeClient(request).getLifeOpsCalendarFeed(),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/calendar/feed",
      expect.any(Object),
      { timeoutMs: LIFEOPS_CALENDAR_FEED_FETCH_TIMEOUT_MS },
    );
  });
});

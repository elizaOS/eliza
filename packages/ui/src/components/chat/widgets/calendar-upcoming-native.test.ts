/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves calendar glance hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setBootConfig } from "../../../config/boot-config";
import { ElizaClient } from "../../../api/client-base";
import type { AgentRequestTransport } from "../../../api/transport";
import {
  CALENDAR_FEED_FETCH_TIMEOUT_MS,
  CALENDAR_PROBE_FETCH_TIMEOUT_MS,
  fetchCalendarConnectorAccounts,
  fetchCalendarUpcomingFeed,
} from "./calendar-upcoming";

function makeClientWithTransport(request: AgentRequestTransport["request"]) {
  const api = new ElizaClient("http://agent.example:2138", "token");
  api.setRequestTransport({ request });
  return api;
}

describe("calendar-upcoming ElizaClient native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the probe deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ accounts: [{ status: "connected" }] }),
    );
    const api = makeClientWithTransport(request);
    await fetchCalendarConnectorAccounts(api);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/connectors/google/accounts",
      expect.any(Object),
      { timeoutMs: CALENDAR_PROBE_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the feed deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ events: [] }),
    );
    const api = makeClientWithTransport(request);
    await fetchCalendarUpcomingFeed(api, new URLSearchParams({ side: "owner" }));
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/calendar/feed?side=owner",
      expect.any(Object),
      { timeoutMs: CALENDAR_FEED_FETCH_TIMEOUT_MS },
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
    const api = makeClientWithTransport(request);
    await expect(
      fetchCalendarUpcomingFeed(
        api,
        new URLSearchParams({ side: "owner" }),
        10,
      ),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/lifeops/calendar/feed?side=owner",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});

/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves the weather approximate-location hop carries timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../api/client-base";
import type { AgentRequestTransport } from "../api/transport";
import { setBootConfig } from "../config/boot-config";
import {
  fetchApproximateCoords,
  WEATHER_APPROXIMATE_LOCATION_FETCH_TIMEOUT_MS,
} from "./useWeather";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("useWeather approximate-location native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the approximate-location deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ lat: 40.71, lon: -74.01 }),
    );
    await expect(
      fetchApproximateCoords(
        WEATHER_APPROXIMATE_LOCATION_FETCH_TIMEOUT_MS,
        makeClient(request),
      ),
    ).resolves.toEqual({
      lat: 40.71,
      lon: -74.01,
      approximate: true,
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/location/approximate",
      expect.any(Object),
      { timeoutMs: WEATHER_APPROXIMATE_LOCATION_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled approximate-location hop through ElizaClient", async () => {
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
      fetchApproximateCoords(10, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/location/approximate",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from the approximate-location hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () => {
      throw Object.assign(new Error("upstream geo provider unavailable"), {
        name: "TypeError",
      });
    });
    await expect(
      fetchApproximateCoords(10_000, makeClient(request)),
    ).rejects.toMatchObject({ name: "ApiError" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/location/approximate",
      expect.any(Object),
      { timeoutMs: 10_000 },
    );
  });
});

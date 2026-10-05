// @vitest-environment jsdom

import { LAST_ACTIVITY_HEADER_NAME } from "@elizaos/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "../client-base";
import { fetchWithCsrf } from "../csrf-client";
import {
  _resetUserActivityForTests,
  getLastUserActivityAt,
  installUserActivityTracker,
  lastActivityHeadersForUrl,
  recordUserActivity,
  USER_ACTIVITY_THROTTLE_MS,
} from "./user-activity";

function captureRequestHeaders(): () => Headers {
  let captured = new Headers();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
    captured = new Headers(init?.headers);
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return () => captured;
}

describe("user activity tracker", () => {
  beforeEach(() => {
    _resetUserActivityForTests();
    installUserActivityTracker();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetUserActivityForTests();
  });

  it("records real interactions and nothing else", () => {
    expect(getLastUserActivityAt()).toBeNull();
    window.dispatchEvent(new Event("mousemove"));
    expect(getLastUserActivityAt()).toBeNull();
    for (const type of ["pointerdown", "keydown", "touchstart", "wheel"]) {
      _resetUserActivityForTests();
      const before = Date.now();
      window.dispatchEvent(new Event(type));
      expect(getLastUserActivityAt()).toBeGreaterThanOrEqual(before);
    }
  });

  it("records the page becoming visible", () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getLastUserActivityAt()).toBeNull();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(getLastUserActivityAt()).not.toBeNull();
  });

  it("throttles recording", () => {
    recordUserActivity(1_000_000);
    recordUserActivity(1_000_000 + USER_ACTIVITY_THROTTLE_MS - 1);
    expect(getLastUserActivityAt()).toBe(1_000_000);
    recordUserActivity(1_000_000 + USER_ACTIVITY_THROTTLE_MS);
    expect(getLastUserActivityAt()).toBe(1_000_000 + USER_ACTIVITY_THROTTLE_MS);
  });

  it("builds the header only for same-origin requests with recorded activity", () => {
    expect(lastActivityHeadersForUrl("/api/status")).toEqual({});
    recordUserActivity(1_234_567);
    expect(lastActivityHeadersForUrl("/api/status")).toEqual({
      [LAST_ACTIVITY_HEADER_NAME]: "1234567",
    });
    expect(lastActivityHeadersForUrl(`${location.origin}/api/status`)).toEqual({
      [LAST_ACTIVITY_HEADER_NAME]: "1234567",
    });
    expect(lastActivityHeadersForUrl("https://other.example/api")).toEqual({});
  });

  it("also sends the header to the configured remote agent API base", () => {
    recordUserActivity(2_000_000);
    const agentBase = "https://agent.example:31337";
    expect(
      lastActivityHeadersForUrl(`${agentBase}/api/status`, agentBase),
    ).toEqual({ [LAST_ACTIVITY_HEADER_NAME]: "2000000" });
    expect(
      lastActivityHeadersForUrl("https://cloud.example/api", agentBase),
    ).toEqual({});
  });

  it("is attached by the shared API client and fetchWithCsrf", async () => {
    const headers = captureRequestHeaders();
    const client = new ElizaClient(location.origin);
    await client.rawRequest("/api/status");
    expect(headers().has(LAST_ACTIVITY_HEADER_NAME)).toBe(false);

    recordUserActivity(2_000_000);
    await client.rawRequest("/api/status");
    expect(headers().get(LAST_ACTIVITY_HEADER_NAME)).toBe("2000000");

    await fetchWithCsrf(`${location.origin}/api/status`);
    expect(headers().get(LAST_ACTIVITY_HEADER_NAME)).toBe("2000000");

    // A client pointed at a remote agent sends activity to that agent (its
    // CORS policy allows the header).
    const remote = new ElizaClient("https://agent.other.example");
    await remote.rawRequest("/api/status");
    expect(headers().get(LAST_ACTIVITY_HEADER_NAME)).toBe("2000000");
  });
});

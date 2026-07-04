/** Exercises desktop http request behavior with deterministic app-core test fixtures. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopHttpRequest,
  normalizeDesktopHttpRequest,
} from "./desktop-http-request";

describe("desktopHttpRequest", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("allows external plain HTTP requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("ok", {
        status: 201,
        statusText: "Created",
        headers: { "content-type": "text/plain" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      desktopHttpRequest({
        url: "http://agent.example:2138/api/auth/status",
        method: "POST",
        headers: { authorization: "Bearer token" },
        body: "{}",
        timeoutMs: 5000,
      }),
    ).resolves.toEqual({
      status: 201,
      statusText: "Created",
      headers: { "content-type": "text/plain" },
      body: "ok",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent.example:2138/api/auth/status",
      expect.objectContaining({
        method: "POST",
        headers: { authorization: "Bearer token" },
        body: "{}",
      }),
    );
  });

  it("rejects non-external or non-plain-HTTP targets in the main process", () => {
    for (const url of [
      "http://127.0.0.1:2138",
      "http://localhost:2138",
      "http://[::1]:2138",
      "http://0.0.0.0:2138",
      "https://agent.example:2138",
    ]) {
      expect(() => normalizeDesktopHttpRequest({ url })).toThrow(
        "configured desktop API plain HTTP",
      );
    }
  });

  it("allows the configured external desktop API base even when it is loopback", () => {
    const previous = process.env.ELIZA_DESKTOP_TEST_API_BASE;
    process.env.ELIZA_DESKTOP_TEST_API_BASE = "http://127.0.0.1:2138";
    try {
      expect(
        normalizeDesktopHttpRequest({
          url: "http://127.0.0.1:2138/api/config",
        }),
      ).toEqual({
        url: "http://127.0.0.1:2138/api/config",
        method: "GET",
        headers: {},
        body: null,
        timeoutMs: undefined,
      });
      expect(() =>
        normalizeDesktopHttpRequest({
          url: "http://127.0.0.1:31337/api/config",
        }),
      ).toThrow("configured desktop API plain HTTP");
    } finally {
      if (typeof previous === "undefined") {
        delete process.env.ELIZA_DESKTOP_TEST_API_BASE;
      } else {
        process.env.ELIZA_DESKTOP_TEST_API_BASE = previous;
      }
    }
  });

  it("times out the full request including response body reads", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => new Promise<string>(() => {}),
      }),
    );

    const request = desktopHttpRequest({
      url: "http://agent.example:2138/api/chat",
      timeoutMs: 1000,
    });
    const assertion = expect(request).rejects.toThrow(
      "desktopHttpRequest timed out after 1000ms.",
    );
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
  });
});

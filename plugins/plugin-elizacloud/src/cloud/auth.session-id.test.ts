/** Exercises the real Cloud login create/poll boundary with deterministic fetch responses. */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./validate-url.js", () => ({
  validateCloudBaseUrl: async () => null,
}));

import { cloudLogin } from "./auth.js";

const SERVER_SESSION_ID = "11111111-2222-4333-8444-555555555555";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cloudLogin server-minted sessions", () => {
  it("opens and polls the authoritative server session without proposing an id", async () => {
    const requests: Array<{ url: string; body?: BodyInit | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), body: init?.body });
        if (requests.length === 1) {
          return new Response(JSON.stringify({ sessionId: SERVER_SESSION_ID }), {
            status: 201,
          });
        }
        return new Response(
          JSON.stringify({ status: "authenticated", apiKey: "elizakey_test" }),
          { status: 200 },
        );
      }),
    );
    const onBrowserUrl = vi.fn();

    const result = await cloudLogin({
      baseUrl: "https://cloud.example.com",
      pollIntervalMs: 0,
      onBrowserUrl,
    });

    expect(requests[0]?.url).toBe(
      "https://cloud.example.com/api/auth/cli-session",
    );
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      sessionId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    });
    expect(requests[1]?.url).toBe(
      `https://cloud.example.com/api/auth/cli-session/${SERVER_SESSION_ID}`,
    );
    expect(onBrowserUrl).toHaveBeenCalledWith(
      `https://cloud.example.com/auth/cli-login?session=${SERVER_SESSION_ID}`,
    );
    expect(result.apiKey).toBe("elizakey_test");
  });

  it.each([{}, { sessionId: "client-chosen" }])(
    "fails closed before opening or polling an invalid create response: %j",
    async (payload) => {
      const fetchMock = vi.fn(async () =>
        new Response(JSON.stringify(payload), { status: 201 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const onBrowserUrl = vi.fn();

      await expect(
        cloudLogin({
          baseUrl: "https://cloud.example.com",
          pollIntervalMs: 0,
          onBrowserUrl,
        }),
      ).rejects.toThrow("invalid login session ID");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(onBrowserUrl).not.toHaveBeenCalled();
    },
  );
});

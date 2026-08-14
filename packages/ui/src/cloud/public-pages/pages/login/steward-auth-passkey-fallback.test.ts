/**
 * Verifies the patched Steward SDK's opt-out from implicit passkey enrollment
 * using its real client implementation with only the HTTP boundary replaced.
 */
// @vitest-environment jsdom

import { StewardApiError, StewardAuth } from "@stwd/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

function jsonResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function recordFetch(responses: Response[]) {
  let calls = 0;
  const fetch = async (): Promise<Response> => {
    const response = responses[calls];
    calls += 1;
    if (!response) throw new Error("Unexpected fetch call");
    return response;
  };
  return { fetch, callCount: () => calls };
}

describe("StewardAuth passkey registration fallback", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("preserves the default smart registration fallback", async () => {
    const recorder = recordFetch([
      jsonResponse(404, "No passkey registered"),
      jsonResponse(401, "Authentication required"),
    ]);
    vi.stubGlobal("fetch", recorder.fetch);
    const auth = new StewardAuth({ baseUrl: "https://api.example.test" });

    await expect(
      auth.signInWithPasskey("person@example.com"),
    ).rejects.toMatchObject({
      status: 401,
      message: "Authentication required",
    });
    expect(recorder.callCount()).toBe(2);
  });

  it("exposes 404 without starting registration when fallback is disabled", async () => {
    const recorder = recordFetch([jsonResponse(404, "No passkey registered")]);
    vi.stubGlobal("fetch", recorder.fetch);
    const auth = new StewardAuth({ baseUrl: "https://api.example.test" });

    const error = await auth
      .signInWithPasskey("person@example.com", {
        fallbackToRegistration: false,
      })
      .catch((cause: unknown) => cause);

    expect(recorder.callCount()).toBe(1);
    expect(error).toBeInstanceOf(StewardApiError);
    expect(error).toMatchObject({
      status: 404,
      message: "No passkey registered",
    });
  });

  it("does not reinterpret non-404 login failures", async () => {
    const recorder = recordFetch([
      jsonResponse(500, "Passkey service unavailable"),
    ]);
    vi.stubGlobal("fetch", recorder.fetch);
    const auth = new StewardAuth({ baseUrl: "https://api.example.test" });

    await expect(
      auth.signInWithPasskey("person@example.com", {
        fallbackToRegistration: false,
      }),
    ).rejects.toMatchObject({
      status: 500,
      message: "Passkey service unavailable",
    });
    expect(recorder.callCount()).toBe(1);
  });
});

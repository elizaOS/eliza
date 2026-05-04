import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authMe } from "./auth-client";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

describe("authMe", () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reports network failures as server unavailable", async () => {
    fetchMock.mockRejectedValue(new Error("connection refused"));

    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 503,
    });
  });

  it("reports non-auth HTTP failures as server unavailable", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 503,
    });
  });

  it("keeps 401 responses as unauthenticated auth failures", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          reason: "remote_auth_required",
          access: {
            mode: "remote",
            passwordConfigured: true,
            ownerConfigured: true,
          },
        }),
        { status: 401 },
      ),
    );

    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 401,
      reason: "remote_auth_required",
      access: {
        mode: "remote",
        passwordConfigured: true,
        ownerConfigured: true,
      },
    });
  });
});

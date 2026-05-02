import { afterEach, describe, expect, it, vi } from "vitest";
import { authMe } from "./auth-client";
import { fetchWithCsrf } from "./csrf-client";

vi.mock("./csrf-client", () => ({
  fetchWithCsrf: vi.fn(),
}));

describe("authMe", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("reports network failures as server unavailable", async () => {
    vi.mocked(fetchWithCsrf).mockRejectedValue(new Error("connection refused"));

    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 503,
    });
  });

  it("reports non-auth HTTP failures as server unavailable", async () => {
    vi.mocked(fetchWithCsrf).mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), { status: 500 }),
    );

    await expect(authMe()).resolves.toEqual({
      ok: false,
      status: 503,
    });
  });

  it("keeps 401 responses as unauthenticated auth failures", async () => {
    vi.mocked(fetchWithCsrf).mockResolvedValue(
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

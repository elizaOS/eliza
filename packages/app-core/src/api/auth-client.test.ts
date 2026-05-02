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
});

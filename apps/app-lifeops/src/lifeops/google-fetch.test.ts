import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleApiError } from "./google-api-error.js";
import { googleApiFetch, rewriteGoogleUrlForMock } from "./google-fetch.js";

describe("googleApiFetch Gmail write guard", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it("blocks real Gmail writes when the guard is enabled", async () => {
    process.env.MILADY_BLOCK_REAL_GMAIL_WRITES = "1";
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    await expect(
      googleApiFetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
        { method: "POST" },
      ),
    ).rejects.toBeInstanceOf(GoogleApiError);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("allows guarded writes when Google traffic is routed to loopback mock", async () => {
    process.env.MILADY_BLOCK_REAL_GMAIL_WRITES = "1";
    process.env.MILADY_MOCK_GOOGLE_BASE = "http://127.0.0.1:4321";
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as
      unknown as typeof fetch;

    await expect(
      googleApiFetch(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages/batchModify",
        { method: "POST" },
      ),
    ).resolves.toBeInstanceOf(Response);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4321/gmail/v1/users/me/messages/batchModify",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("rejects non-loopback Google mock bases", () => {
    process.env.MILADY_MOCK_GOOGLE_BASE = "https://mock.example.com";
    expect(() =>
      rewriteGoogleUrlForMock(
        "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      ),
    ).toThrow(GoogleApiError);
  });
});

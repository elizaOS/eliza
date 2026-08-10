/**
 * Deterministic HTTP-contract coverage for revoking a Cloud-managed personal
 * Google grant without exposing its bearer in a URL or persisted metadata.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { revokeGoogleOAuthGrant } from "./generic-adapter";

const originalFetch = globalThis.fetch;

describe("Google OAuth grant revocation", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts the vault-revealed token as form data", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await revokeGoogleOAuthGrant("refresh-token-secret");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/revoke",
      expect.objectContaining({
        method: "POST",
        body: "token=refresh-token-secret",
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("refresh-token-secret");
  });
});

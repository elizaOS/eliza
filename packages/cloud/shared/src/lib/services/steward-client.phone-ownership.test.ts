/** Verifies bearer-bound Steward phone ownership without trusting a browser hint. */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { StewardPhoneOwnershipError, verifyStewardBearerPhone } from "./steward-client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  mock.restore();
});

function stewardResponse(accounts: unknown[]): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: { accounts, primaryLoginMethods: [] },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("verifyStewardBearerPhone", () => {
  test("accepts an exact E.164 phone linked to the authenticated bearer", async () => {
    globalThis.fetch = mock(async (input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe("https://steward.example/user/me/accounts");
      expect(request.headers.get("authorization")).toBe("Bearer session-token");
      expect(request.headers.get("x-steward-tenant")).toBe("personal-user-1");
      return stewardResponse([
        {
          id: "account-1",
          provider: "phone",
          providerAccountId: "+14155552671",
          expiresAt: null,
        },
      ]);
    }) as typeof fetch;

    await expect(
      verifyStewardBearerPhone({
        env: { STEWARD_API_URL: "https://steward.example" },
        bearerToken: "session-token",
        tenantId: "personal-user-1",
        phoneNumber: "+1 (415) 555-2671",
      }),
    ).resolves.toEqual({
      status: "verified",
      phoneNumber: "+14155552671",
    });
  });

  test("does not accept a non-phone account whose identifier resembles a phone", async () => {
    globalThis.fetch = mock(async () =>
      stewardResponse([
        {
          id: "account-1",
          provider: "google",
          providerAccountId: "+14155552671",
          expiresAt: null,
        },
      ]),
    ) as typeof fetch;

    await expect(
      verifyStewardBearerPhone({
        env: { STEWARD_API_URL: "https://steward.example" },
        bearerToken: "session-token",
        phoneNumber: "+14155552671",
      }),
    ).resolves.toEqual({ status: "not_linked" });
  });

  test("rejects an invalid hint before contacting Steward", async () => {
    const fetchMock = mock(async () => stewardResponse([]));
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(
      verifyStewardBearerPhone({
        env: { STEWARD_API_URL: "https://steward.example" },
        bearerToken: "session-token",
        phoneNumber: "not-a-phone",
      }),
    ).rejects.toMatchObject<Partial<StewardPhoneOwnershipError>>({
      code: "invalid_phone",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("surfaces Steward failure distinctly from an unlinked phone", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ ok: false, error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    await expect(
      verifyStewardBearerPhone({
        env: { STEWARD_API_URL: "https://steward.example" },
        bearerToken: "session-token",
        phoneNumber: "+14155552671",
      }),
    ).rejects.toMatchObject<Partial<StewardPhoneOwnershipError>>({
      code: "upstream_unavailable",
    });
  });
});

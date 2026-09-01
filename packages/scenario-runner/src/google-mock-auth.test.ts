/** Unit tests for unexpected Google mock 401/403 detection without live Google. */
import { describe, expect, it } from "vitest";
import { unexpectedGoogleMockAuthFailureDetail } from "./google-mock-auth.ts";

describe("unexpectedGoogleMockAuthFailureDetail", () => {
  it("returns null when every Google request was admitted or reset", () => {
    expect(
      unexpectedGoogleMockAuthFailureDetail([
        {
          method: "GET",
          path: "/gmail/v1/users/me/messages",
          statusCode: 200,
          googleAuth: {
            action: "auth",
            authStatus: "admitted",
            admittedAccountEmail: "owner@example.test",
            requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
            resetGeneration: 0,
            statusCode: 200,
          },
        },
        {
          method: "POST",
          path: "/__mock/google/reset",
          statusCode: 200,
          googleAuth: {
            action: "reset",
            authStatus: "reset",
            resetGeneration: 1,
          },
        },
      ]),
    ).toBeNull();
  });

  it("fails closed on rejected 401/403 instead of treating empty data as a pass", () => {
    const detail = unexpectedGoogleMockAuthFailureDetail([
      {
        method: "GET",
        path: "/gmail/v1/users/me/messages",
        statusCode: 401,
        googleAuth: {
          action: "auth",
          authStatus: "rejected",
          admittedAccountEmail: "owner@example.test",
          statusCode: 401,
        },
      },
    ]);
    expect(detail).toMatch(/Unexpected Google mock authorization failure/);
    expect(detail).toMatch(/GET \/gmail\/v1\/users\/me\/messages/);
    expect(detail).toContain("account=owner@example.test");
    expect(detail).not.toMatch(/Bearer|access.token|refresh/i);
  });
});

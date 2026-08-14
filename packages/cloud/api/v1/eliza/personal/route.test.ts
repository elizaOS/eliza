/** Verifies read-only personal identity resolution never enters chat or provisioning. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: "00000000-0000-4000-8000-000000000001",
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

const { default: app } = await import("./route");

describe("personal Eliza identity", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
  });

  test("returns one deterministic rowless Shared identity", async () => {
    const response = await app.request("/");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: {
        identity: { id: string; displayName: string; runtime: string };
      };
    };
    expect(body).toEqual({
      success: true,
      data: {
        identity: {
          id: expect.stringMatching(/^personal:/),
          displayName: "Eliza",
          runtime: "shared",
        },
      },
    });
    expect(requireUserOrApiKeyWithOrg).toHaveBeenCalledTimes(1);
  });
});

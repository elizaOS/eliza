/** Verifies personal Eliza status stays independent of runtime history and compute. */

import { describe, expect, mock, test } from "bun:test";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "00000000-0000-4000-8000-000000000002",
  organization_id: "00000000-0000-4000-8000-000000000001",
}));
const resolvePersonalElizaIdentity = mock(async () => ({
  id: "personal-00000000-0000-4000-8000-000000000001",
  displayName: "Eliza",
  runtime: "shared" as const,
}));

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/services/shared-runtime/personal-eliza-identity", () => ({
  resolvePersonalElizaIdentity,
}));

const { default: app } = await import("./route");

describe("personal Eliza status route", () => {
  test("returns one account-native identity without reading history", async () => {
    const response = await app.request("/", undefined, {
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.test",
    } as never);
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
          id: "personal-00000000-0000-4000-8000-000000000001",
          displayName: "Eliza",
          runtime: "shared",
        },
      },
    });
    expect(resolvePersonalElizaIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "00000000-0000-4000-8000-000000000001",
        execution_tier: "shared",
      }),
      "cloud.test",
    );
  });
});

import type { SensitiveRequest } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { instructDmOnlySensitiveRequestAdapter } from "./instruct-dm-only-adapter";

function buildRequest(
  overrides: Partial<SensitiveRequest> = {},
): SensitiveRequest {
  const now = new Date("2026-05-10T00:00:00.000Z").toISOString();
  const expires = new Date("2026-05-10T00:15:00.000Z").toISOString();
  return {
    id: "req_test",
    kind: "secret",
    status: "pending",
    agentId: "agent_test",
    target: { kind: "secret", key: "OPENAI_API_KEY" },
    policy: {
      actor: "owner_or_linked_identity",
      requirePrivateDelivery: true,
      requireAuthenticatedLink: true,
      allowInlineOwnerAppEntry: true,
      allowPublicLink: false,
      allowDmFallback: true,
      allowTunnelLink: true,
      allowCloudLink: true,
    },
    delivery: {
      kind: "secret",
      source: "public",
      mode: "dm_or_owner_app_instruction",
      policy: {
        actor: "owner_or_linked_identity",
        requirePrivateDelivery: true,
        requireAuthenticatedLink: true,
        allowInlineOwnerAppEntry: true,
        allowPublicLink: false,
        allowDmFallback: true,
        allowTunnelLink: true,
        allowCloudLink: true,
      },
      privateRouteRequired: true,
      publicLinkAllowed: false,
      authenticated: false,
      canCollectValueInCurrentChannel: false,
      reason: "no private or authenticated delivery route is available",
      instruction:
        "Do not collect the secret here. Ask the owner to use a DM or the owner app.",
    },
    expiresAt: expires,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("instructDmOnlySensitiveRequestAdapter", () => {
  it("declares the instruct_dm_only target", () => {
    expect(instructDmOnlySensitiveRequestAdapter.target).toBe(
      "instruct_dm_only",
    );
  });

  it("delivers successfully with formRendered=false and no url", async () => {
    const request = buildRequest();
    const result = await instructDmOnlySensitiveRequestAdapter.deliver({
      request,
      runtime: {},
    });
    expect(result).toEqual({
      delivered: true,
      target: "instruct_dm_only",
      expiresAt: request.expiresAt,
      formRendered: false,
    });
  });

  it("succeeds for any kind including payment", async () => {
    const request = buildRequest({
      kind: "payment",
      target: { kind: "payment" },
    });
    const result = await instructDmOnlySensitiveRequestAdapter.deliver({
      request,
      runtime: {},
    });
    expect(result.delivered).toBe(true);
    if (result.delivered) {
      expect(result.url).toBeUndefined();
      expect(result.formRendered).toBe(false);
    }
  });
});

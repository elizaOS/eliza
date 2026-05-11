import type {
  DispatchSensitiveRequest,
  SensitiveRequest,
  SensitiveRequestKind,
  SensitiveRequestTarget,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createCloudLinkSensitiveRequestAdapter } from "./cloud-link-adapter";

const EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const CREATED_AT = "2024-01-01T00:00:00.000Z";
function makeRequest(
  kind: SensitiveRequestKind,
  overrides: {
    id?: string;
    target?: SensitiveRequestTarget;
    callback?: SensitiveRequest["callback"];
  } = {},
): DispatchSensitiveRequest {
  const target: SensitiveRequestTarget =
    overrides.target ??
    (kind === "secret"
      ? { kind: "secret", key: "OPENAI_API_KEY" }
      : kind === "private_info"
        ? { kind: "private_info", fields: [{ name: "email" }] }
        : kind === "payment"
          ? { kind: "payment" }
          : { kind: "oauth" });

  return {
    id: overrides.id ?? "req-123",
    kind,
    status: "pending",
    agentId: "agent-1",
    target,
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
      kind,
      source: "api",
      mode: "cloud_authenticated_link",
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
      authenticated: true,
      canCollectValueInCurrentChannel: false,
      reason: "test",
      instruction: "test",
    },
    callback: overrides.callback,
    expiresAt: EXPIRES_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  } as unknown as DispatchSensitiveRequest;
}

describe("cloudLinkSensitiveRequestAdapter", () => {
  it("declares the cloud_authenticated_link target", () => {
    const adapter = createCloudLinkSensitiveRequestAdapter();
    expect(adapter.target).toBe("cloud_authenticated_link");
  });

  it("returns the cloud sensitive-request URL for secret kind", async () => {
    const adapter = createCloudLinkSensitiveRequestAdapter({
      resolveCloudBase: () => "https://www.elizacloud.ai",
    });
    const result = await adapter.deliver({
      request: makeRequest("secret", { id: "req-abc" }),
      runtime: null,
    });
    expect(result).toEqual({
      delivered: true,
      target: "cloud_authenticated_link",
      url: "https://www.elizacloud.ai/sensitive-requests/req-abc",
      expiresAt: EXPIRES_AT,
    });
  });

  it("returns cloud URL for oauth and private_info kinds", async () => {
    const adapter = createCloudLinkSensitiveRequestAdapter({
      resolveCloudBase: () => "https://www.elizacloud.ai",
    });
    const oauth = await adapter.deliver({
      request: makeRequest("oauth", { id: "req-oauth" }),
      runtime: null,
    });
    expect(oauth.url).toBe(
      "https://www.elizacloud.ai/sensitive-requests/req-oauth",
    );
    const priv = await adapter.deliver({
      request: makeRequest("private_info", { id: "req-priv" }),
      runtime: null,
    });
    expect(priv.url).toBe(
      "https://www.elizacloud.ai/sensitive-requests/req-priv",
    );
  });

  it("returns 'cloud not paired' when resolver returns null", async () => {
    const adapter = createCloudLinkSensitiveRequestAdapter({
      resolveCloudBase: () => null,
    });
    const result = await adapter.deliver({
      request: makeRequest("secret"),
      runtime: null,
    });
    expect(result).toEqual({
      delivered: false,
      target: "cloud_authenticated_link",
      error: "cloud not paired",
    });
  });

  it("builds the payment URL when appId is present in target metadata", async () => {
    const adapter = createCloudLinkSensitiveRequestAdapter({
      resolveCloudBase: () => "https://www.elizacloud.ai",
    });
    const result = await adapter.deliver({
      request: makeRequest("payment", {
        id: "req-pay",
        target: { kind: "payment", appId: "app-42" },
      }),
      runtime: null,
    });
    expect(result).toEqual({
      delivered: true,
      target: "cloud_authenticated_link",
      url: "https://www.elizacloud.ai/payment/app-charge/app-42/req-pay",
      expiresAt: EXPIRES_AT,
    });
  });

  it("falls back to callback.appId for payment URL when target has none", async () => {
    const adapter = createCloudLinkSensitiveRequestAdapter({
      resolveCloudBase: () => "https://www.elizacloud.ai",
    });
    const result = await adapter.deliver({
      request: makeRequest("payment", {
        id: "req-pay-2",
        target: { kind: "payment" },
        callback: { appId: "app-from-callback" },
      }),
      runtime: null,
    });
    expect(result.url).toBe(
      "https://www.elizacloud.ai/payment/app-charge/app-from-callback/req-pay-2",
    );
  });

  it("returns structured error for payment kind without appId", async () => {
    const adapter = createCloudLinkSensitiveRequestAdapter({
      resolveCloudBase: () => "https://www.elizacloud.ai",
    });
    const result = await adapter.deliver({
      request: makeRequest("payment", {
        target: { kind: "payment" },
      }),
      runtime: null,
    });
    expect(result).toEqual({
      delivered: false,
      target: "cloud_authenticated_link",
      error: "payment request missing appId",
    });
  });

  it("encodes the request id to keep URLs safe", async () => {
    const adapter = createCloudLinkSensitiveRequestAdapter({
      resolveCloudBase: () => "https://www.elizacloud.ai",
    });
    const result = await adapter.deliver({
      request: makeRequest("secret", { id: "req with spaces" }),
      runtime: null,
    });
    expect(result.url).toBe(
      "https://www.elizacloud.ai/sensitive-requests/req%20with%20spaces",
    );
  });
});

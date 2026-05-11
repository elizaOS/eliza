import type {
  SensitiveRequest,
  SensitiveRequestKind,
  SensitiveRequestTarget,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createTunnelLinkSensitiveRequestAdapter } from "./tunnel-link-adapter";

const EXPIRES_AT = "2099-01-01T00:00:00.000Z";
const CREATED_AT = "2024-01-01T00:00:00.000Z";

function makeRequest(
  kind: SensitiveRequestKind,
  overrides: { id?: string; target?: SensitiveRequestTarget } = {},
): SensitiveRequest {
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
    id: overrides.id ?? "req-tun",
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
      mode: "tunnel_authenticated_link",
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
    expiresAt: EXPIRES_AT,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  };
}

describe("tunnelLinkSensitiveRequestAdapter", () => {
  it("declares the tunnel_authenticated_link target", () => {
    const adapter = createTunnelLinkSensitiveRequestAdapter();
    expect(adapter.target).toBe("tunnel_authenticated_link");
  });

  it("returns the tunnel-served URL when an active tunnel is reported", async () => {
    const adapter = createTunnelLinkSensitiveRequestAdapter({
      getTunnelStatus: () => ({
        active: true,
        url: "https://abc.ngrok.app",
      }),
    });
    const result = await adapter.deliver({
      request: makeRequest("secret", { id: "req-1" }),
      runtime: null,
    });
    expect(result).toEqual({
      delivered: true,
      target: "tunnel_authenticated_link",
      url: "https://abc.ngrok.app/api/sensitive-requests/req-1",
      expiresAt: EXPIRES_AT,
    });
  });

  it("strips trailing slashes from the tunnel base URL", async () => {
    const adapter = createTunnelLinkSensitiveRequestAdapter({
      getTunnelStatus: () => ({
        active: true,
        url: "https://abc.ngrok.app///",
      }),
    });
    const result = await adapter.deliver({
      request: makeRequest("private_info", { id: "req-2" }),
      runtime: null,
    });
    expect(result.url).toBe(
      "https://abc.ngrok.app/api/sensitive-requests/req-2",
    );
  });

  it("returns 'no active tunnel' when the tunnel is inactive", async () => {
    const adapter = createTunnelLinkSensitiveRequestAdapter({
      getTunnelStatus: () => ({ active: false, url: null }),
    });
    const result = await adapter.deliver({
      request: makeRequest("secret"),
      runtime: null,
    });
    expect(result).toEqual({
      delivered: false,
      target: "tunnel_authenticated_link",
      error: "no active tunnel",
    });
  });

  it("returns 'no active tunnel' when the tunnel reports active but no URL", async () => {
    const adapter = createTunnelLinkSensitiveRequestAdapter({
      getTunnelStatus: () => ({ active: true, url: null }),
    });
    const result = await adapter.deliver({
      request: makeRequest("secret"),
      runtime: null,
    });
    expect(result).toEqual({
      delivered: false,
      target: "tunnel_authenticated_link",
      error: "no active tunnel",
    });
  });

  it("returns 'no active tunnel' when the resolver returns null", async () => {
    const adapter = createTunnelLinkSensitiveRequestAdapter({
      getTunnelStatus: () => null,
    });
    const result = await adapter.deliver({
      request: makeRequest("secret"),
      runtime: null,
    });
    expect(result).toEqual({
      delivered: false,
      target: "tunnel_authenticated_link",
      error: "no active tunnel",
    });
  });

  it("builds the tunnel URL for payment kind without requiring appId", async () => {
    const adapter = createTunnelLinkSensitiveRequestAdapter({
      getTunnelStatus: () => ({
        active: true,
        url: "https://abc.ngrok.app",
      }),
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
      target: "tunnel_authenticated_link",
      url: "https://abc.ngrok.app/api/sensitive-requests/req-pay",
      expiresAt: EXPIRES_AT,
    });
  });

  it("uses the runtime tunnel service when no resolver is injected", async () => {
    const adapter = createTunnelLinkSensitiveRequestAdapter();
    const runtime = {
      getService: (name: string) => {
        if (name !== "tunnel") return null;
        return {
          getStatus: () => ({
            active: true,
            url: "https://from-runtime.example",
          }),
        };
      },
    };
    const result = await adapter.deliver({
      request: makeRequest("secret", { id: "req-rt" }),
      runtime,
    });
    expect(result.url).toBe(
      "https://from-runtime.example/api/sensitive-requests/req-rt",
    );
  });
});

/**
 * Unit tests for `publicLinkSensitiveRequestAdapter`: verifies it emits a public
 * app-charge URL only for `any_payer` payment requests carrying an `appId`,
 * resolves the cloud base from the runtime setting / env / default, URL-encodes
 * path components, and refuses secrets, verified-payer payments, and missing appId.
 */
import type {
  SensitiveRequest,
  SensitiveRequestWithPaymentContext,
} from "@elizaos/core";
import { getBootConfig, setBootConfig } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicLinkSensitiveRequestAdapter } from "./public-link-adapter";

const SAVED_ENV_KEYS = [
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZA_CLOUD_BASE_URL",
] as const;

function buildRequest(
  overrides: Partial<SensitiveRequestWithPaymentContext> = {},
): SensitiveRequestWithPaymentContext {
  // The local SensitiveRequest construction below uses the policy shape;
  // the cast at return time satisfies the dispatch contract.
  const now = new Date("2026-05-10T00:00:00.000Z").toISOString();
  const expires = new Date("2026-05-10T00:15:00.000Z").toISOString();
  const base: SensitiveRequest = {
    id: "req_pay_1",
    kind: "payment",
    status: "pending",
    agentId: "agent_test",
    target: { kind: "payment", appId: "app_demo" },
    policy: {
      actor: "any_payer",
      requirePrivateDelivery: false,
      requireAuthenticatedLink: false,
      allowInlineOwnerAppEntry: true,
      allowPublicLink: true,
      allowDmFallback: true,
      allowTunnelLink: true,
      allowCloudLink: true,
    },
    delivery: {
      kind: "payment",
      source: "public",
      mode: "public_link",
      policy: {
        actor: "any_payer",
        requirePrivateDelivery: false,
        requireAuthenticatedLink: false,
        allowInlineOwnerAppEntry: true,
        allowPublicLink: true,
        allowDmFallback: true,
        allowTunnelLink: true,
        allowCloudLink: true,
      },
      privateRouteRequired: false,
      publicLinkAllowed: true,
      authenticated: false,
      canCollectValueInCurrentChannel: false,
      reason: "payment context allows any payer",
      instruction: "A public link is allowed for this payment request.",
    },
    expiresAt: expires,
    createdAt: now,
    updatedAt: now,
  };
  return {
    ...base,
    paymentContext: { kind: "any_payer" },
    ...overrides,
  } as unknown as SensitiveRequestWithPaymentContext;
}

function runtimeWithSetting(value: string | undefined) {
  return {
    getSetting(key: string) {
      if (key === "ELIZAOS_CLOUD_BASE_URL") return value ?? null;
      return null;
    },
  };
}

describe("publicLinkSensitiveRequestAdapter", () => {
  const savedConfig = getBootConfig();
  let savedEnv: Record<(typeof SAVED_ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      SAVED_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof SAVED_ENV_KEYS)[number], string | undefined>;
  });

  afterEach(() => {
    setBootConfig(savedConfig);
    for (const key of SAVED_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("declares the public_link target", () => {
    expect(publicLinkSensitiveRequestAdapter.target).toBe("public_link");
  });

  it("returns a public URL for any_payer payment with appId", async () => {
    const request = buildRequest();
    const result = await publicLinkSensitiveRequestAdapter.deliver({
      request,
      runtime: runtimeWithSetting("https://cloud.example.com/api/v1/"),
    });
    expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error("expected success");
    expect(result.url).toBe(
      "https://cloud.example.com/api/v1/payment/app-charge/app_demo/req_pay_1/public",
    );
    expect(result.expiresAt).toBe(request.expiresAt);
    expect(result.target).toBe("public_link");
  });

  it("falls back to the default cloud base when no setting or env is provided", async () => {
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.ELIZA_CLOUD_BASE_URL;
    const result = await publicLinkSensitiveRequestAdapter.deliver({
      request: buildRequest(),
      runtime: runtimeWithSetting(undefined),
    });
    expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error("expected success");
    expect(result.url).toBe(
      "https://elizacloud.ai/api/v1/payment/app-charge/app_demo/req_pay_1/public",
    );
  });

  it("refuses kind=secret with a structured error", async () => {
    const request = buildRequest({
      kind: "secret",
      target: { kind: "secret", key: "OPENAI_API_KEY" },
    });
    const result = await publicLinkSensitiveRequestAdapter.deliver({
      request,
      runtime: runtimeWithSetting("https://cloud.example.com/api/v1"),
    });
    expect(result).toEqual({
      delivered: false,
      target: "public_link",
      error: "public_link only allowed for any_payer payment",
    });
  });

  it("refuses kind=payment with verified_payer context", async () => {
    const request = buildRequest({
      paymentContext: { kind: "verified_payer" },
    });
    const result = await publicLinkSensitiveRequestAdapter.deliver({
      request,
      runtime: runtimeWithSetting("https://cloud.example.com/api/v1"),
    });
    expect(result).toEqual({
      delivered: false,
      target: "public_link",
      error: "public_link only allowed for any_payer payment",
    });
  });

  it("refuses kind=payment without any paymentContext", async () => {
    const request = buildRequest();
    // strip paymentContext entirely
    const stripped: SensitiveRequestWithPaymentContext = {
      ...request,
      paymentContext: undefined,
    };
    const result = await publicLinkSensitiveRequestAdapter.deliver({
      request: stripped,
      runtime: runtimeWithSetting("https://cloud.example.com/api/v1"),
    });
    expect(result.delivered).toBe(false);
    if (result.delivered) throw new Error("expected failure");
    expect(result.error).toBe("public_link only allowed for any_payer payment");
  });

  it("refuses any_payer payment when appId is missing", async () => {
    const request = buildRequest({
      target: { kind: "payment" },
    });
    const result = await publicLinkSensitiveRequestAdapter.deliver({
      request,
      runtime: runtimeWithSetting("https://cloud.example.com/api/v1"),
    });
    expect(result).toEqual({
      delivered: false,
      target: "public_link",
      error: "public_link payment request is missing appId",
    });
  });

  it("URL-encodes appId and request id components", async () => {
    const request = buildRequest({
      id: "req with space",
      target: { kind: "payment", appId: "app/with/slash" },
    });
    const result = await publicLinkSensitiveRequestAdapter.deliver({
      request,
      runtime: runtimeWithSetting("https://cloud.example.com"),
    });
    expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error("expected success");
    expect(result.url).toBe(
      "https://cloud.example.com/payment/app-charge/app%2Fwith%2Fslash/req%20with%20space/public",
    );
  });

  it("resolves the public cloud base from an aliased env key without mutating canonical env", async () => {
    setBootConfig({
      ...savedConfig,
      envAliases: [["ELIZA_CLOUD_BASE_URL", "ELIZAOS_CLOUD_BASE_URL"]],
    });
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    process.env.ELIZA_CLOUD_BASE_URL = "https://legacy.example.com/api/v1/";

    const result = await publicLinkSensitiveRequestAdapter.deliver({
      request: buildRequest(),
      runtime: runtimeWithSetting(undefined),
    });

    expect(result.delivered).toBe(true);
    if (!result.delivered) throw new Error("expected success");
    expect(result.url).toBe(
      "https://legacy.example.com/api/v1/payment/app-charge/app_demo/req_pay_1/public",
    );
    expect(process.env.ELIZAOS_CLOUD_BASE_URL).toBeUndefined();
  });
});

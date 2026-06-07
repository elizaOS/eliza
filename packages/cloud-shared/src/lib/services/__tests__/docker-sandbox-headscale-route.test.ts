import { afterEach, describe, expect, test } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import {
  buildStewardProvisioningSignedHeaders,
  buildStewardRuntimeAuthEnv,
  canProvisionCoreAgentWithoutStewardRegistration,
  DockerSandboxProvider,
  requiresHeadscaleRoute,
  resolveContainerPort,
  resolveDockerSandboxImage,
  resolveStewardProvisioningSigningSecret,
} from "../docker-sandbox-provider";

const savedEnv = { ...process.env };

afterEach(() => {
  // Restore env by mutation, never by reassigning `process.env`. Replacing the
  // global env object swaps out Bun's special process.env, which breaks env
  // reads (and the DNS resolver config) for every later test in the same
  // process — surfacing as unrelated env/DNS failures elsewhere in the run.
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe("requiresHeadscaleRoute", () => {
  test("does not require Headscale routing when Headscale is not configured", () => {
    expect(requiresHeadscaleRoute({})).toBe(false);
    expect(requiresHeadscaleRoute({ HEADSCALE_API_KEY: "" })).toBe(false);
  });

  test("requires a persisted headscale route when Headscale is configured", () => {
    expect(requiresHeadscaleRoute({ HEADSCALE_API_KEY: "secret" })).toBe(true);
  });

  test("requires Headscale routing for public cloud agent ingress", () => {
    expect(
      requiresHeadscaleRoute({
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "waifu.fun",
      }),
    ).toBe(true);
    expect(
      requiresHeadscaleRoute({
        CONTAINERS_PUBLIC_BASE_DOMAIN: "containers.elizacloud.ai",
      }),
    ).toBe(true);
  });

  test("requires Headscale routing for deployed cloud environments", () => {
    expect(requiresHeadscaleRoute({ ENVIRONMENT: "production" })).toBe(true);
    expect(requiresHeadscaleRoute({ ENVIRONMENT: "staging" })).toBe(true);
    expect(requiresHeadscaleRoute({ ENVIRONMENT: "development" })).toBe(false);
  });

  test("requires Headscale routing when Headscale URL config is present", () => {
    expect(
      requiresHeadscaleRoute({
        HEADSCALE_API_URL: "https://headscale.elizacloud.ai",
      }),
    ).toBe(true);
  });

  test("allows explicit legacy bridge-host fallback", () => {
    expect(
      requiresHeadscaleRoute({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
      }),
    ).toBe(false);
    expect(
      requiresHeadscaleRoute({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "true",
      }),
    ).toBe(false);
    expect(
      requiresHeadscaleRoute({
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "waifu.fun",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
      }),
    ).toBe(false);
  });
});

describe("resolveDockerSandboxImage", () => {
  test("prefers a per-agent image over the operator default image", () => {
    expect(
      resolveDockerSandboxImage("ghcr.io/dexploarer/bnancy:latest", "ghcr.io/elizaos/eliza:stable"),
    ).toBe("ghcr.io/dexploarer/bnancy:latest");
  });

  test("uses the operator default when no per-agent image is set", () => {
    expect(resolveDockerSandboxImage(undefined, "ghcr.io/elizaos/eliza:stable")).toBe(
      "ghcr.io/elizaos/eliza:stable",
    );
  });
});

describe("resolveContainerPort", () => {
  const baseConfig = {
    agentId: "11111111-1111-4111-8111-111111111111",
    agentName: "BNancy",
    organizationId: "22222222-2222-4222-8222-222222222222",
  };

  test("uses HTTP_PORT when PORT is absent", () => {
    expect(
      resolveContainerPort({
        ...baseConfig,
        environmentVars: { HTTP_PORT: "3000" },
      }),
    ).toBe("3000");
  });

  test("prefers PORT over HTTP_PORT", () => {
    expect(
      resolveContainerPort({
        ...baseConfig,
        environmentVars: { PORT: "2138", HTTP_PORT: "3000" },
      }),
    ).toBe("2138");
  });
});

function sha256TextHex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Steward provisioning signing", () => {
  test("does not use tenant API keys as request-signing secrets", () => {
    expect(
      resolveStewardProvisioningSigningSecret({
        STEWARD_TENANT_API_KEY: "tenant-key",
      }),
    ).toBeUndefined();
    expect(
      resolveStewardProvisioningSigningSecret({
        STEWARD_REQUEST_SIGNING_SECRETS: " first-secret , second-secret ",
        STEWARD_TENANT_API_KEY: "tenant-key",
      }),
    ).toBe("first-secret");
  });

  test("matches the Steward mutating request signature contract", () => {
    const secret = "test_only_steward_secret_aaaaaaaaaaaaa";
    const body = JSON.stringify({ id: "agent-1", name: "Agent" });
    const headers = buildStewardProvisioningSignedHeaders({
      path: "/agents",
      body,
      tenantId: "elizacloud",
      apiKey: "tenant-api-key",
      signingSecret: secret,
    });

    expect(headers["X-Steward-Request-Timestamp"]).toBeUndefined();
    expect(headers["Idempotency-Key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["X-Steward-Request-Expires-At"]).toMatch(/^\d+$/);

    const canonical = [
      "steward-request-signature-v1",
      "POST",
      "/agents",
      "elizacloud",
      sha256TextHex(""),
      sha256TextHex("tenant-api-key"),
      sha256TextHex(""),
      sha256TextHex(""),
      sha256TextHex(""),
      sha256TextHex(""),
      sha256TextHex(""),
      "",
      headers["X-Steward-Request-Expires-At"],
      headers["Idempotency-Key"],
      sha256TextHex(body),
    ].join("\n");
    const signature = createHmac("sha256", secret).update(canonical).digest("hex");

    expect(headers["X-Steward-Signature"]).toBe(`v1=${signature}`);
  });
});

describe("Steward runtime auth env", () => {
  test("allows core cloud agent provisioning without Steward registration when cloud auth exists", () => {
    expect(
      canProvisionCoreAgentWithoutStewardRegistration({
        ELIZA_CLOUD_PROVISIONED: "1",
        ELIZA_API_TOKEN: "agent-token",
      }),
    ).toBe(true);
    expect(
      canProvisionCoreAgentWithoutStewardRegistration({
        ELIZA_CLOUD_PROVISIONED: "1",
        ELIZAOS_CLOUD_API_KEY: "cloud-api-key",
      }),
    ).toBe(true);
  });

  test("does not allow degraded Steward registration for non-cloud or unauthenticated agents", () => {
    expect(
      canProvisionCoreAgentWithoutStewardRegistration({
        ELIZA_API_TOKEN: "agent-token",
      }),
    ).toBe(false);
    expect(
      canProvisionCoreAgentWithoutStewardRegistration({
        ELIZA_CLOUD_PROVISIONED: "1",
      }),
    ).toBe(false);
  });

  test("supports first-party JWT auth without a legacy Steward agent token", () => {
    process.env.ELIZA_CLOUD_PUBLIC_URL = "https://elizacloud.ai/api";

    expect(
      buildStewardRuntimeAuthEnv({
        stewardJwt: "jwt-token",
        stewardRefreshServiceToken: "service-token",
      }),
    ).toEqual({
      STEWARD_JWT: "jwt-token",
      STEWARD_JWT_FILE: "/app/data/steward.jwt",
      STEWARD_REFRESH_URL: "https://elizacloud.ai/api/v1/agent-tokens",
      STEWARD_REFRESH_SERVICE_TOKEN: "service-token",
    });
  });

  test("includes the legacy Steward agent token only when registration succeeds", () => {
    expect(
      buildStewardRuntimeAuthEnv({
        stewardAgentToken: "steward-agent-token",
        stewardJwt: "",
        stewardRefreshServiceToken: "",
      }),
    ).toEqual({
      STEWARD_AGENT_TOKEN: "steward-agent-token",
    });
  });
});

describe("DockerSandboxProvider Headscale route guard", () => {
  test("rejects public cloud provisioning before a sandbox can be marked running without Headscale config", async () => {
    process.env.ENVIRONMENT = "production";
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "waifu.fun";
    process.env.HEADSCALE_API_KEY = "";
    process.env.AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK = "";

    const provider = new DockerSandboxProvider();

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Suki",
        organizationId: "22222222-2222-4222-8222-222222222222",
        environmentVars: {},
      }),
    ).rejects.toThrow("HEADSCALE_API_KEY is not configured");
  });
});

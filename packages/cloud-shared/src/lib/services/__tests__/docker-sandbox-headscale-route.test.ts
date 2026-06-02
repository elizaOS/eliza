import { afterEach, describe, expect, test } from "bun:test";
import { DockerSandboxProvider, requiresHeadscaleRoute } from "../docker-sandbox-provider";

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

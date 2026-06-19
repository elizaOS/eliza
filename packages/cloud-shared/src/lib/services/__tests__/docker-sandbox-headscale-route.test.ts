import { afterEach, describe, expect, test } from "bun:test";
import {
  DockerSandboxProvider,
  headscaleVpnEnabled,
  requiresHeadscaleRoute,
  resolveContainerPort,
  resolveDockerSandboxImage,
  shouldCleanupHeadscaleVpn,
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

describe("headscaleVpnEnabled", () => {
  test("enabled when an API key is configured and no fallback is requested", () => {
    expect(headscaleVpnEnabled({ HEADSCALE_API_KEY: "secret" })).toBe(true);
  });

  test("disabled when no API key is configured", () => {
    expect(headscaleVpnEnabled({})).toBe(false);
    expect(headscaleVpnEnabled({ HEADSCALE_API_KEY: "" })).toBe(false);
    expect(headscaleVpnEnabled({ HEADSCALE_API_KEY: "   " })).toBe(false);
  });

  test("disabled when the operator opts into legacy bridge-host fallback", () => {
    // The fallback flag must also stop TS_AUTHKEY injection, not just relax the
    // route-required guard — otherwise the container entrypoint hard-`tailscale
    // up`s and dies under `set -e` on nodes that aren't on the mesh, which is
    // exactly what the flag is meant to bypass.
    expect(
      headscaleVpnEnabled({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
      }),
    ).toBe(false);
    expect(
      headscaleVpnEnabled({
        HEADSCALE_API_KEY: "secret",
        AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "true",
      }),
    ).toBe(false);
  });

  test("stays consistent with requiresHeadscaleRoute under the fallback flag", () => {
    // When the fallback is on, neither the route nor the VPN enrollment is
    // required — the container boots over the legacy bridge-host path.
    const env = {
      HEADSCALE_API_KEY: "secret",
      AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
    };
    expect(requiresHeadscaleRoute(env)).toBe(false);
    expect(headscaleVpnEnabled(env)).toBe(false);
  });
});

describe("shouldCleanupHeadscaleVpn", () => {
  test("cleans up only when VPN is enabled and a registered node name is present", () => {
    expect(shouldCleanupHeadscaleVpn({ HEADSCALE_API_KEY: "secret" }, "agent-org-example")).toBe(
      true,
    );
    expect(shouldCleanupHeadscaleVpn({ HEADSCALE_API_KEY: "secret" }, undefined)).toBe(false);
  });

  test("does not clean up fallback-mode containers even when an API key is configured", () => {
    expect(
      shouldCleanupHeadscaleVpn(
        {
          HEADSCALE_API_KEY: "secret",
          AGENT_ROUTER_ALLOW_BRIDGE_HOST_FALLBACK: "1",
        },
        "agent-org-example",
      ),
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

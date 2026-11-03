import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import {
  forwardableSubAgentEnv,
  isDeniedSpawnEnvKey,
  isDeniedSubAgentEnvKey,
  isForwardedCloudCredentialKey,
} from "../services/sub-agent-env-policy.ts";

// Host-side ELIZA_* secrets a coding sub-agent never needs. The values are
// placeholders; the test is about which names survive the filter.
const HOST_ONLY = {
  ELIZA_WALLET_EXPORT_TOKEN: "wallet-step-up",
  ELIZA_DEVICE_PAIRING_TOKEN: "pairing",
  ELIZA_DEVICE_BRIDGE_TOKEN: "bridge",
  ELIZA_TOKEN_ENCRYPTION_KEY: "at-rest-key",
  ELIZA_SERVICE_JWT_SECRET: "jwt",
  ELIZA_WEB_PUSH_VAPID_PRIVATE_KEY: "vapid",
};
const CLOUD_ALIASES = {
  ELIZA_CLOUD_API_KEY: "owner-cloud-bearer",
  ELIZA_CLOUD_TOKEN: "owner-cloud-token",
};
const FORWARDED = {
  PATH: "/usr/bin",
  ELIZA_CLAUDE_EFFORT: "high",
  ELIZA_CLOUD_BASE_URL: "https://cloud.example",
  ELIZA_APP_IMAGE_REGISTRY_USERNAME: "pusher",
  ELIZA_APP_IMAGE_REGISTRY_TOKEN: "registry-push",
};

describe("sub-agent env: host-only ELIZA_* credentials", () => {
  it("forwards a sub-agent's own ELIZA_* settings but not host step-up secrets", () => {
    const env = forwardableSubAgentEnv({
      ...HOST_ONLY,
      ...CLOUD_ALIASES,
      ...FORWARDED,
    });
    expect(Object.keys(env).sort()).toEqual(Object.keys(FORWARDED).sort());
  });

  it("lets the ELIZA_CLOUD_* credential aliases follow the ELIZAOS_CLOUD opt-in", () => {
    const env = forwardableSubAgentEnv(
      { ...HOST_ONLY, ...CLOUD_ALIASES, ...FORWARDED },
      true,
    );
    expect(Object.keys(env).sort()).toEqual(
      [...Object.keys(FORWARDED), ...Object.keys(CLOUD_ALIASES)].sort(),
    );
    for (const key of Object.keys(CLOUD_ALIASES)) {
      expect(isForwardedCloudCredentialKey(key)).toBe(true);
    }
    expect(isForwardedCloudCredentialKey("ELIZA_CLOUD_BASE_URL")).toBe(false);
  });

  it("denies the same secrets when a spawn request supplies them as customCredentials", () => {
    for (const key of Object.keys(HOST_ONLY)) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(true);
    }
    expect(isDeniedSubAgentEnvKey("eliza_wallet_export_token")).toBe(true);
    expect(isDeniedSubAgentEnvKey("ELIZA_APP_IMAGE_REGISTRY_TOKEN")).toBe(
      false,
    );
    expect(isDeniedSubAgentEnvKey("ELIZA_CLAUDE_EFFORT")).toBe(false);
  });

  it("keeps the per-child credentials the spawner mints out of the host and caller paths only", () => {
    for (const key of [
      "ELIZA_CREDENTIAL_BRIDGE_TOKEN",
      "ELIZA_PI_ROUTE_API_KEY",
    ]) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(true);
      expect(isDeniedSpawnEnvKey(key)).toBe(false);
    }
    expect(isDeniedSpawnEnvKey("ELIZA_WALLET_EXPORT_TOKEN")).toBe(true);
    expect(isDeniedSpawnEnvKey("ELIZA_ACP_WARM_CLAIM_TOKEN")).toBe(true);
  });

  it("gates the owner's Cloud credentials on the caller paths with the same opt-in", () => {
    for (const key of [
      ...Object.keys(CLOUD_ALIASES),
      "ELIZA_CLOUD_CLIENT_ADDRESS_KEY",
      "ELIZAOS_CLOUD_API_KEY",
    ]) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(true);
      expect(isDeniedSpawnEnvKey(key)).toBe(true);
      expect(isDeniedSubAgentEnvKey(key, true)).toBe(false);
      expect(isDeniedSpawnEnvKey(key, true)).toBe(false);
    }
    // Non-credential Cloud settings are not owner credentials.
    expect(isDeniedSubAgentEnvKey("ELIZA_CLOUD_BASE_URL")).toBe(false);
    // The opt-in does not reopen any other host-only secret.
    expect(isDeniedSubAgentEnvKey("ELIZA_WALLET_EXPORT_TOKEN", true)).toBe(
      true,
    );
  });
});

describe("AcpService child env: minted credentials reach the child, host secrets do not", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("applies the minted bridge token and Pi route key from the spawn env while denying host and caller secrets", () => {
    // Host process.env copies of the minted names are not the child's values.
    vi.stubEnv("ELIZA_CREDENTIAL_BRIDGE_TOKEN", "host-bridge");
    vi.stubEnv("ELIZA_WALLET_EXPORT_TOKEN", "host-wallet");
    const service = new AcpService({
      agentId: "00000000-0000-4000-8000-000000024097",
      character: { name: "Env policy tester" },
      getSetting: () => undefined,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      reportError() {},
      getService: () => null,
    } as never);
    const buildEnv = (
      service as unknown as {
        buildEnv: (
          extra: Record<string, string>,
          customCredentials: Record<string, string>,
          model: string | undefined,
          agentType: string,
        ) => NodeJS.ProcessEnv;
      }
    ).buildEnv.bind(service);

    const env = buildEnv(
      {
        ELIZA_CREDENTIAL_BRIDGE_TOKEN: "minted-bridge",
        ELIZA_PI_ROUTE_API_KEY: "minted-route",
        ELIZA_PI_PROVIDER_ROUTE: "route-1",
        ELIZA_WALLET_EXPORT_TOKEN: "spawn-env-wallet",
      },
      {
        ELIZA_CREDENTIAL_BRIDGE_TOKEN: "caller-bridge",
        ELIZA_TOKEN_ENCRYPTION_KEY: "caller-key",
      },
      undefined,
      "codex",
    );
    expect(env.ELIZA_CREDENTIAL_BRIDGE_TOKEN).toBe("minted-bridge");
    expect(env.ELIZA_PI_ROUTE_API_KEY).toBe("minted-route");
    expect(env.ELIZA_PI_PROVIDER_ROUTE).toBe("route-1");
    expect(env.ELIZA_WALLET_EXPORT_TOKEN).toBeUndefined();
    expect(env.ELIZA_TOKEN_ENCRYPTION_KEY).toBeUndefined();

    // The same built env filtered again (the cli transport does this in
    // runAcpx) keeps the minted values.
    const again = buildEnv(
      Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      {},
      undefined,
      "codex",
    );
    expect(again.ELIZA_CREDENTIAL_BRIDGE_TOKEN).toBe("minted-bridge");
    expect(again.ELIZA_PI_ROUTE_API_KEY).toBe("minted-route");
  });

  const CALLER_CLOUD = {
    ELIZA_CLOUD_API_KEY: "caller-cloud-bearer",
    ELIZA_CLOUD_CLIENT_ADDRESS_KEY: "caller-signing-key",
    ELIZAOS_CLOUD_API_KEY: "caller-canonical-bearer",
  };

  function cloudService(warnings: string[]) {
    const service = new AcpService({
      agentId: "00000000-0000-4000-8000-000000024098",
      character: { name: "Env policy tester" },
      getSetting: () => undefined,
      logger: {
        debug() {},
        info() {},
        warn(message: string) {
          warnings.push(message);
        },
        error() {},
      },
      reportError() {},
      getService: () => null,
    } as never);
    return (
      service as unknown as {
        buildEnv: (
          extra: Record<string, string>,
          customCredentials: Record<string, string>,
          model: string | undefined,
          agentType: string,
        ) => NodeJS.ProcessEnv;
      }
    ).buildEnv.bind(service);
  }

  it("does not let customCredentials or the spawn env carry an owner Cloud key without the opt-in", () => {
    vi.stubEnv("ELIZA_FORWARD_CLOUD_KEY_TO_SUBAGENTS", "");
    const warnings: string[] = [];
    const buildEnv = cloudService(warnings);
    for (const [extra, custom] of [
      [CALLER_CLOUD, {}],
      [{}, CALLER_CLOUD],
    ] as const) {
      const env = buildEnv(
        { ...extra, ELIZA_CLOUD_BASE_URL: "https://cloud.example" },
        { ...custom },
        undefined,
        "codex",
      );
      for (const key of Object.keys(CALLER_CLOUD)) {
        expect(env[key]).toBeUndefined();
      }
      expect(env.ELIZA_CLOUD_BASE_URL).toBe("https://cloud.example");
    }
    expect(
      warnings.some((w) => w.includes("ELIZA_FORWARD_CLOUD_KEY_TO_SUBAGENTS")),
    ).toBe(false);
  });

  it("with the opt-in, admits a caller's Cloud key and warns about it", () => {
    vi.stubEnv("ELIZA_FORWARD_CLOUD_KEY_TO_SUBAGENTS", "1");
    const warnings: string[] = [];
    const buildEnv = cloudService(warnings);
    const env = buildEnv({}, { ...CALLER_CLOUD }, undefined, "codex");
    for (const [key, value] of Object.entries(CALLER_CLOUD)) {
      expect(env[key]).toBe(value);
    }
    // The key arrived only through customCredentials, so the warning must be
    // computed on the merged env, not on the process.env projection.
    expect(
      warnings.some((w) => w.includes("ELIZA_FORWARD_CLOUD_KEY_TO_SUBAGENTS")),
    ).toBe(true);
  });
});

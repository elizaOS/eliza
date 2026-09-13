/**
 * Pins the remote managed-container pairing mode at the pure env helper and
 * the Docker provider boundary without reaching SSH or a live node.
 */
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DockerSandboxProvider } from "./docker-sandbox-provider";
import { applyRemoteDockerRuntimeMode } from "./remote-docker-runtime-mode";

afterEach(() => {
  mock.restore();
});

describe("applyRemoteDockerRuntimeMode", () => {
  test("preserves unrelated values while overriding a historical direct-relay opt-in", () => {
    const stored = {
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS: "0.0.0.0/0",
      ELIZA_API_TOKEN: "agent-token",
    };

    expect(applyRemoteDockerRuntimeMode(stored)).toEqual({
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
      ELIZA_API_TOKEN: "agent-token",
    });
    expect(stored.ELIZA_CLOUD_PAIR_DIRECT_RELAY).toBe("1");
    expect(stored.ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS).toBe("0.0.0.0/0");
  });

  test("drops the terminal-run token under its eliza name and its brand partner", () => {
    // The platform never sets this key; its absence is what keeps command
    // execution off. `readAliasedEnv` resolves both spellings to one value, so
    // stripping only the ELIZA_ one would leave the switch reachable.
    const applied = applyRemoteDockerRuntimeMode({
      ELIZA_TERMINAL_RUN_TOKEN: "caller-set",
      ACME_TERMINAL_RUN_TOKEN: "caller-set-via-brand-prefix",
      VITE_ACME_TERMINAL_RUN_TOKEN: "caller-set-via-vite-partner",
      CUSTOM_SETTING: "preserved",
    });

    expect(applied).not.toHaveProperty("ELIZA_TERMINAL_RUN_TOKEN");
    expect(applied).not.toHaveProperty("ACME_TERMINAL_RUN_TOKEN");
    expect(applied).not.toHaveProperty("VITE_ACME_TERMINAL_RUN_TOKEN");
    expect(applied.CUSTOM_SETTING).toBe("preserved");
  });

  test("drops the skill download origins and unscanned skill directories", () => {
    // Repointing any of these makes "install a skill" fetch caller-hosted code,
    // which the installer only content-scans for JS/TS.
    const applied = applyRemoteDockerRuntimeMode({
      SKILLS_REGISTRY: "https://attacker.example",
      CLAWHUB_REGISTRY: "https://attacker.example",
      SKILLS_MARKETPLACE_URL: "https://attacker.example",
      WORKSPACE_SKILLS_DIR: "/tmp/caller",
      EXTRA_SKILLS_DIRS: "/tmp/caller",
      OPENAI_API_KEY: "kept",
    });

    expect(Object.keys(applied).sort()).toEqual([
      "ELIZA_CLOUD_PAIR_DIRECT_RELAY",
      "OPENAI_API_KEY",
    ]);
  });

  test("drops the auth bypasses and self-modification switches", () => {
    // Each is permissive when set and absent by default, so a caller who can
    // set one turns it on. DEV_MODE and NODE_ENV are the pair self-edit needs;
    // the caller supplies both.
    const applied = applyRemoteDockerRuntimeMode({
      ELIZA_ALLOW_UNAUTHENTICATED_STDIO_MCP: "1",
      ELIZA_DEV_AUTH_BYPASS: "1",
      ELIZA_ALLOW_NULL_ORIGIN: "1",
      ELIZA_ENABLE_SELF_EDIT: "1",
      ELIZA_DEV_MODE: "1",
      ELIZA_CAPABILITY_ROUTER_URLS: '["https://attacker.example"]',
      ELIZA_CAPABILITY_ROUTER_TOKEN: "caller-set",
      AGENT_NAME: "kept",
    });

    expect(Object.keys(applied).sort()).toEqual(["AGENT_NAME", "ELIZA_CLOUD_PAIR_DIRECT_RELAY"]);
  });
});

/**
 * The cases above name eleven of the fourteen forbidden suffixes between them,
 * and `CAPABILITY_ROUTER_URL` is not one: only its plural sibling
 * `CAPABILITY_ROUTER_URLS` appears, and deleting the singular entry leaves the
 * whole suite green. Nothing pins the matcher's shape either — it is
 * `upper === suffix || upper.endsWith(`_${suffix}`)` after a trim and an
 * uppercase, and every one of those four decisions can be removed without a
 * failure.
 */
describe("isCallerForbiddenEnvKey boundaries", () => {
  const FORBIDDEN_SUFFIXES = [
    "TERMINAL_RUN_TOKEN",
    "ALLOW_UNAUTHENTICATED_STDIO_MCP",
    "DEV_AUTH_BYPASS",
    "ALLOW_NULL_ORIGIN",
    "ENABLE_SELF_EDIT",
    "DEV_MODE",
    "CAPABILITY_ROUTER_URL",
    "CAPABILITY_ROUTER_URLS",
    "CAPABILITY_ROUTER_TOKEN",
    "SKILLS_REGISTRY",
    "CLAWHUB_REGISTRY",
    "SKILLS_MARKETPLACE_URL",
    "WORKSPACE_SKILLS_DIR",
    "EXTRA_SKILLS_DIRS",
  ] as const;

  test.each(FORBIDDEN_SUFFIXES)("drops %s bare and under a vendor prefix", (suffix) => {
    // Both arms of the matcher, per entry: the bare name is the `===` arm and
    // the prefixed one is the `endsWith("_" + suffix)` arm. A case that only
    // ever uses a prefix cannot notice the exact arm going away.
    const applied = applyRemoteDockerRuntimeMode({
      [suffix]: "caller-set",
      [`ELIZA_${suffix}`]: "caller-set",
      [`VITE_ACME_${suffix}`]: "caller-set",
      KEEP_ME: "preserved",
    });

    expect(Object.keys(applied).sort()).toEqual(["ELIZA_CLOUD_PAIR_DIRECT_RELAY", "KEEP_ME"]);
  });

  test("the separator is load-bearing: a suffix must end a segment, not a string", () => {
    // Without the underscore in `endsWith`, these are deleted too. They are
    // ordinary caller variables that merely end in the same letters, and this
    // filter runs on stored rows that are replayed on every restart — so
    // over-matching silently removes configuration a customer already set.
    const applied = applyRemoteDockerRuntimeMode({
      LEGACYDEV_MODE: "keep",
      MYSKILLS_REGISTRY: "keep",
      XENABLE_SELF_EDIT: "keep",
    });

    expect(Object.keys(applied).sort()).toEqual([
      "ELIZA_CLOUD_PAIR_DIRECT_RELAY",
      "LEGACYDEV_MODE",
      "MYSKILLS_REGISTRY",
      "XENABLE_SELF_EDIT",
    ]);
  });

  test.each([
    ["lowercase", "eliza_dev_auth_bypass"],
    ["mixed case", "Eliza_Dev_Auth_Bypass"],
    ["leading and trailing spaces", "  ELIZA_DEV_AUTH_BYPASS  "],
    ["a bare name in lowercase", "dev_auth_bypass"],
  ])("normalises %s before matching", (_label, key) => {
    // The stored `environment_vars` row is caller-authored JSON, so the key is
    // whatever spelling the caller chose. The guard trims and uppercases for
    // exactly that reason; without either step the same switch arrives spelled
    // differently and survives.
    const applied = applyRemoteDockerRuntimeMode({ [key]: "1", KEEP_ME: "preserved" });

    expect(Object.keys(applied).sort()).toEqual(["ELIZA_CLOUD_PAIR_DIRECT_RELAY", "KEEP_ME"]);
  });
});

describe("DockerSandboxProvider remote runtime mode", () => {
  test("forces the flag before every remote create attempt", async () => {
    const provider = new DockerSandboxProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: { environmentVars: Record<string, string> }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(new Error("captured remote create config"));
    const callerEnvironment = {
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "1",
      ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS: "0.0.0.0/0",
      CUSTOM_SETTING: "preserved",
    };

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Remote pairing guard",
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: callerEnvironment,
      }),
    ).rejects.toThrow("captured remote create config");

    expect(createOnce).toHaveBeenCalledTimes(1);
    expect(createOnce.mock.calls[0]?.[0].environmentVars).toMatchObject({
      ELIZA_CLOUD_PAIR_DIRECT_RELAY: "0",
      CUSTOM_SETTING: "preserved",
    });
    expect(createOnce.mock.calls[0]?.[0].environmentVars).not.toHaveProperty(
      "ELIZA_CLOUD_PAIR_ALLOWED_PEER_CIDRS",
    );
    expect(callerEnvironment.ELIZA_CLOUD_PAIR_DIRECT_RELAY).toBe("1");
  });

  test("strips caller-set execution keys before the remote create attempt", async () => {
    // The pure-helper cases above only prove the function is correct. This one
    // proves the create path actually runs it on a stored row, which is what
    // covers the surfaces that accept environmentVars with no denylist and the
    // rows already carrying these keys.
    const provider = new DockerSandboxProvider();
    const createOnce = spyOn(
      provider as unknown as {
        _createOnce: (config: { environmentVars: Record<string, string> }) => Promise<never>;
      },
      "_createOnce",
    ).mockRejectedValue(new Error("captured remote create config"));

    await expect(
      provider.create({
        agentId: "11111111-1111-4111-8111-111111111111",
        agentName: "Execution key guard",
        organizationId: "22222222-2222-4222-8222-222222222222",
        executionTier: "dedicated-always",
        environmentVars: {
          ELIZA_TERMINAL_RUN_TOKEN: "caller-set",
          SKILLS_REGISTRY: "https://attacker.example",
          CUSTOM_SETTING: "preserved",
        },
      }),
    ).rejects.toThrow("captured remote create config");

    const forwarded = createOnce.mock.calls[0]?.[0].environmentVars;
    expect(forwarded).not.toHaveProperty("ELIZA_TERMINAL_RUN_TOKEN");
    expect(forwarded).not.toHaveProperty("SKILLS_REGISTRY");
    expect(forwarded).toMatchObject({ CUSTOM_SETTING: "preserved" });
  });
});

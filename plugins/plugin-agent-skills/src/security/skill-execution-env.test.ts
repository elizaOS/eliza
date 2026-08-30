import {
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSkillExecutionEnv,
  isInheritableSkillEnvKey,
} from "./skill-execution-env";

/**
 * Fleet-scoped credentials: one value shared by every container, as opposed to
 * the per-agent keys alongside them. None is in BLOCKED_SPAWN_ENV_KEYS, which is
 * why an allowlist rather than a denylist is what keeps them out.
 */
const FLEET_SCOPED = {
  AGENT_SERVER_SHARED_SECRET: "shared-across-every-agent-container",
  ELIZA_LOCAL_ROOT_KEY: "derives-every-org-dek",
  SANDBOX_REGISTRY_REDIS_URL: "redis://shared-registry",
  STEWARD_REFRESH_SERVICE_TOKEN: "mints-a-jwt-for-any-agent-id",
  DATABASE_URL: "postgres://shared",
};

const CLOUD_TEST_ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZA_CLOUD_BASE_URL",
  "ELIZA_CLOUD_PUBLIC_URL",
  "ELIZA_CLOUD_URL",
] as const;

const originalCloudTestEnv = Object.fromEntries(
  CLOUD_TEST_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof CLOUD_TEST_ENV_KEYS)[number], string | undefined>;

afterEach(() => {
  for (const key of CLOUD_TEST_ENV_KEYS) {
    const value = originalCloudTestEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("buildSkillExecutionEnv", () => {
  it("does not pass fleet-scoped credentials to a skill child process", () => {
    const env = buildSkillExecutionEnv(
      { ...FLEET_SCOPED, PATH: "/usr/bin", HOME: "/root" },
      {},
    );

    for (const key of Object.keys(FLEET_SCOPED)) {
      expect(env).not.toHaveProperty(key);
    }
    expect(env.HOME).toBe("/root");
  });

  it("keeps the agent-scoped cloud identity, which is minted per agent", () => {
    const env = buildSkillExecutionEnv(
      {
        ELIZAOS_CLOUD_API_KEY: "agent-own-key",
        // The spelling the platform actually injects.
        ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app",
        // The spelling the bundled eliza-cloud skill documents.
        ELIZA_CLOUD_BASE_URL: "https://api.eliza.app",
        PATH: "/usr/bin",
      },
      {},
    );

    expect(env.ELIZAOS_CLOUD_API_KEY).toBe("agent-own-key");
    expect(env.ELIZAOS_CLOUD_BASE_URL).toBe("https://api.eliza.app");
    expect(env.ELIZA_CLOUD_BASE_URL).toBe("https://api.eliza.app");
  });

  it.each(["staging-default", "offline"])(
    "blocks hostile Cloud inheritance and overlays under %s authority",
    (authority) => {
      const env = buildSkillExecutionEnv(
        {
          ELIZA_DEV_SOURCE: "1",
          ELIZA_DEV_CLOUD_ENV_AUTHORITY: authority,
          ELIZAOS_CLOUD_API_KEY: "late-production-key",
          ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
          ELIZA_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
          ELIZA_CLOUD_PUBLIC_URL: "https://cloud.eliza.app",
          ELIZA_CLOUD_URL: "https://api.eliza.app/api/v1",
          PATH: "/usr/bin",
        },
        {
          ELIZAOS_CLOUD_API_KEY: "overlay-production-key",
          ELIZAOS_CLOUD_BASE_URL: "https://attacker.example/api/v1",
        },
      );

      expect(env.ELIZAOS_CLOUD_API_KEY).toBe("");
      expect(env.ELIZAOS_CLOUD_BASE_URL).toBe(
        "https://api-staging.eliza.app/api/v1",
      );
      expect(env.ELIZA_CLOUD_BASE_URL).toBe("");
      expect(env.ELIZA_CLOUD_PUBLIC_URL).toBe("");
      expect(env.ELIZA_CLOUD_URL).toBe("");
    },
  );

  it.each([
    ["staging-explicit", "https://api-staging.eliza.app/api/v1"],
    ["self-hosted", "https://api.private.example/api/v1"],
  ])(
    "pins the launch Cloud tuple for %s authority after live env pollution",
    (authority, launchBaseUrl) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_API_KEY = "launch-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = launchBaseUrl;
      process.env.ELIZA_CLOUD_BASE_URL = launchBaseUrl;
      resolveDevCloudEnvAuthority();

      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL =
        "https://api.eliza.app/api/v1";
      process.env.ELIZA_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

      const env = buildSkillExecutionEnv(process.env, {
        ELIZAOS_CLOUD_API_KEY: "overlay-production-key",
        ELIZAOS_CLOUD_BASE_URL: "https://attacker.example/api/v1",
      });

      expect(env.ELIZAOS_CLOUD_API_KEY).toBe("launch-key");
      expect(env.ELIZAOS_CLOUD_BASE_URL).toBe(launchBaseUrl);
      expect(env.ELIZA_CLOUD_BASE_URL).toBe(launchBaseUrl);
    },
  );

  it("passes the parent's own PATH through rather than a substitute", () => {
    const env = buildSkillExecutionEnv({ PATH: "/opt/custom/bin:/bin" }, {});

    expect(env.PATH).toBe("/opt/custom/bin:/bin");
  });

  it("refuses to build an env with no PATH instead of letting bash synthesize one", () => {
    // A synthesized bash PATH ends in `.`, so a bare command name would resolve
    // against the working directory. Fail closed.
    expect(() => buildSkillExecutionEnv({ HOME: "/root" }, {})).toThrow(
      /no PATH/,
    );
  });

  it("drops an unrecognised ambient key rather than passing it through", () => {
    const env = buildSkillExecutionEnv(
      { PATH: "/usr/bin", SOME_FUTURE_PLATFORM_SECRET: "leaked" },
      {},
    );

    expect(env).not.toHaveProperty("SOME_FUTURE_PLATFORM_SECRET");
  });

  it("strips spawn-injection primitives from the per-skill overlay", () => {
    const env = buildSkillExecutionEnv(
      { PATH: "/usr/bin" },
      {
        LD_PRELOAD: "/tmp/evil.so",
        NODE_OPTIONS: "--require /tmp/evil.js",
        BASH_FUNC_x: "() { :; }",
        GEMINI_API_KEY: "legitimate",
      },
    );

    expect(env).not.toHaveProperty("LD_PRELOAD");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
    expect(env).not.toHaveProperty("BASH_FUNC_x");
    expect(env.GEMINI_API_KEY).toBe("legitimate");
  });

  it("lets the overlay replace an inherited value", () => {
    const env = buildSkillExecutionEnv(
      { PATH: "/usr/bin", GEMINI_API_KEY: "ambient" },
      { GEMINI_API_KEY: "from-skill-config" },
    );

    expect(env.GEMINI_API_KEY).toBe("from-skill-config");
  });

  it("wins over an inherited entry that differs only in case", () => {
    // POSIX treats these as two variables. Writing only the exact name would
    // ship both, and a child reading the documented uppercase spelling would
    // still get the ambient value — silently using the wrong credential.
    const env = buildSkillExecutionEnv(
      { PATH: "/usr/bin", GEMINI_API_KEY: "ambient" },
      { Gemini_Api_Key: "from-skill-config" },
    );

    const spellings = Object.keys(env).filter(
      (key) => key.toUpperCase() === "GEMINI_API_KEY",
    );
    expect(spellings).toHaveLength(1);
    expect(env[spellings[0]]).toBe("from-skill-config");
  });
});

describe("isInheritableSkillEnvKey", () => {
  it("agrees with what the filter emits, so eligibility cannot report green then fail", () => {
    // The eligibility check calls this; if the two disagreed, a skill would be
    // reported ready and then spawned without the variable it declared.
    expect(isInheritableSkillEnvKey("GEMINI_API_KEY")).toBe(true);
    expect(isInheritableSkillEnvKey("gemini_api_key")).toBe(true);
    expect(isInheritableSkillEnvKey("AGENT_SERVER_SHARED_SECRET")).toBe(false);
    expect(isInheritableSkillEnvKey("SOME_THIRD_PARTY_KEY")).toBe(false);
  });
});

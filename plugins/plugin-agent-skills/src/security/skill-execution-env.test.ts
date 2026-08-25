import { describe, expect, it } from "vitest";
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
    expect(() =>
      buildSkillExecutionEnv({ PATH: "   ", HOME: "/root" }, {}),
    ).toThrow(/no PATH/);
    expect(() =>
      buildSkillExecutionEnv({ PATH: "\t\n", HOME: "/root" }, {}),
    ).toThrow(/no PATH/);
  });

  it("passes all authorized host environment keys through", () => {
    const hostEnv = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      TMPDIR: "/tmp/custom",
      TMP: "/tmp/custom",
      TEMP: "/tmp/custom",
      SHELL: "/bin/zsh",
      TERM: "xterm-256color",
      USER: "eliza",
      LOGNAME: "eliza",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8",
      TZ: "UTC",
    };
    const env = buildSkillExecutionEnv(hostEnv, {});
    for (const [key, value] of Object.entries(hostEnv)) {
      expect(env[key]).toBe(value);
    }
  });

  it("passes all agent-scoped and skill-declared keys through", () => {
    const authorizedKeys = {
      PATH: "/usr/bin",
      ELIZAOS_CLOUD_API_KEY: "cloud-key",
      ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app",
      ELIZA_CLOUD_BASE_URL: "https://api.eliza.app",
      ELIZA_CLOUD_PUBLIC_URL: "https://public.eliza.app",
      ELIZA_CLOUD_URL: "https://cloud.eliza.app",
      ELIZA_APP_ID: "app-uuid-123",
      GEMINI_API_KEY: "gemini-key",
      OTTO_TMUX_SOCKET_DIR: "/tmp/otto-tmux",
      NOTION_API_KEY: "notion-key",
      TRELLO_API_KEY: "trello-key",
      TRELLO_TOKEN: "trello-token",
      THINGS_AUTH_TOKEN: "things-token",
    };
    const env = buildSkillExecutionEnv(authorizedKeys, {});
    for (const [key, value] of Object.entries(authorizedKeys)) {
      expect(env[key]).toBe(value);
    }
  });

  it("ignores undefined values in processEnv and overlay", () => {
    const env = buildSkillExecutionEnv(
      { PATH: "/usr/bin", HOME: undefined, GEMINI_API_KEY: "valid" },
      { NOTION_API_KEY: undefined as unknown as string, TRELLO_KEY: "set" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GEMINI_API_KEY).toBe("valid");
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("NOTION_API_KEY");
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
      { PATH: "/usr/bin", GEMINI_API_KEY: "ambient", TRELLO_TOKEN: "ambient-token" },
      { Gemini_Api_Key: "from-skill-config", trello_token: "overlay-token" },
    );

    const geminiKeys = Object.keys(env).filter(
      (key) => key.toUpperCase() === "GEMINI_API_KEY",
    );
    expect(geminiKeys).toHaveLength(1);
    expect(env[geminiKeys[0]]).toBe("from-skill-config");

    const trelloKeys = Object.keys(env).filter(
      (key) => key.toUpperCase() === "TRELLO_TOKEN",
    );
    expect(trelloKeys).toHaveLength(1);
    expect(env[trelloKeys[0]]).toBe("overlay-token");
  });
});

describe("isInheritableSkillEnvKey", () => {
  it("agrees with what the filter emits, so eligibility cannot report green then fail", () => {
    // The eligibility check calls this; if the two disagreed, a skill would be
    // reported ready and then spawned without the variable it declared.
    expect(isInheritableSkillEnvKey("GEMINI_API_KEY")).toBe(true);
    expect(isInheritableSkillEnvKey("gemini_api_key")).toBe(true);
    expect(isInheritableSkillEnvKey("ELIZA_APP_ID")).toBe(true);
    expect(isInheritableSkillEnvKey("eliza_app_id")).toBe(true);
    expect(isInheritableSkillEnvKey("THINGS_AUTH_TOKEN")).toBe(true);
    expect(isInheritableSkillEnvKey("things_auth_token")).toBe(true);
    expect(isInheritableSkillEnvKey("AGENT_SERVER_SHARED_SECRET")).toBe(false);
    expect(isInheritableSkillEnvKey("SOME_THIRD_PARTY_KEY")).toBe(false);
  });
});

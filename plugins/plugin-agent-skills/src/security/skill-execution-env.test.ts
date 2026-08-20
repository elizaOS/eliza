import { describe, expect, it } from "vitest";
import { buildSkillExecutionEnv } from "./skill-execution-env";

/**
 * The five keys below were measured byte-identical across five production agent
 * containers on five different nodes, while the per-agent keys in the same
 * containers all differed. Each carries authority over the whole fleet rather
 * than over the tenant whose container holds it, which is why a skill script
 * must never receive them.
 */
const FLEET_SCOPED = {
  AGENT_SERVER_SHARED_SECRET: "authenticates-as-owner-on-every-agent",
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
  });

  it("keeps the agent-scoped cloud identity, which is minted per agent", () => {
    // ELIZAOS_CLOUD_API_KEY comes from createForAgent(org, user, sandbox), so a
    // skill reading it reads its own agent's key. Four bundled skills document
    // doing exactly that.
    const env = buildSkillExecutionEnv(
      {
        ELIZAOS_CLOUD_API_KEY: "agent-own-key",
        ELIZA_CLOUD_BASE_URL: "https://api.eliza.app",
        PATH: "/usr/bin",
      },
      {},
    );

    expect(env.ELIZAOS_CLOUD_API_KEY).toBe("agent-own-key");
    expect(env.ELIZA_CLOUD_BASE_URL).toBe("https://api.eliza.app");
  });

  it("keeps a usable PATH, because the spawn sites use bare interpreter names", () => {
    // use-skill.ts spawns `python3` / `bash` / `node` by name. An env without
    // PATH does not secure the skill, it breaks every skill.
    const env = buildSkillExecutionEnv({ PATH: "/usr/bin:/bin" }, {});

    expect(typeof env.PATH).toBe("string");
    expect(env.PATH?.length).toBeGreaterThan(0);
  });

  it("drops an unrecognised ambient key rather than passing it through", () => {
    const env = buildSkillExecutionEnv(
      { PATH: "/usr/bin", SOME_FUTURE_PLATFORM_SECRET: "leaked" },
      {},
    );

    expect(env).not.toHaveProperty("SOME_FUTURE_PLATFORM_SECRET");
  });

  it("strips spawn-injection primitives from the per-skill overlay", () => {
    // setSkillEnv accepts arbitrary keys with no validation, so the overlay is
    // a caller-controlled channel into the child environment.
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

  it("lets the overlay supply a credential the ambient env does not carry", () => {
    const env = buildSkillExecutionEnv(
      { PATH: "/usr/bin" },
      { NOTION_KEY: "from-skill-config" },
    );

    expect(env.NOTION_KEY).toBe("from-skill-config");
  });
});

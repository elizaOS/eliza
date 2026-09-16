/** Exercises sandbox configuration and bootstrap contracts with deterministic inputs. Lifecycle prototype simulations are not installed in this suite. */
/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { describe, expect, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { resolveSandboxContainerLaunchConfig } from ".././sandbox-container-launch-config";

describe("resolveSandboxContainerLaunchConfig", () => {
  test("maps stored waifu container hints to sandbox provider launch config", () => {
    expect(
      resolveSandboxContainerLaunchConfig({
        container: {
          projectName: "waifu-smoke-agent",
          port: 3000,
          cpu: 512,
          memory: 1024,
          desiredCount: 1,
          architecture: "arm64",
          healthCheckPath: "/api/health",
        },
      }),
    ).toEqual({
      projectName: "waifu-smoke-agent",
      port: 3000,
      cpu: 512,
      memoryMb: 1024,
      desiredCount: 1,
      architecture: "arm64",
      healthCheckPath: "/api/health",
    });
  });

  test("ignores invalid or absent container hints", () => {
    expect(
      resolveSandboxContainerLaunchConfig({
        container: {
          projectName: "",
          port: 0,
          cpu: -1,
          memory: Number.NaN,
          desiredCount: 1.5,
          architecture: "riscv64",
          healthCheckPath: "",
        },
      }),
    ).toBeUndefined();
    expect(resolveSandboxContainerLaunchConfig({})).toBeUndefined();
  });
});

describe("buildAgentSandboxInsertValues", () => {
  test("derives trusted storage fields while rejecting caller-owned internal config", async () => {
    const { buildAgentSandboxInsertValues } = await import(".././eliza-sandbox.ts?actual");

    expect(
      buildAgentSandboxInsertValues({
        organizationId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        agentName: "bnancy",
        characterId: "44444444-4444-4444-8444-444444444444",
        executionTier: "custom",
        agentConfig: {
          bio: "A real caller-owned persona",
          __agentUpgradedFrom: "forged-source-agent",
        },
        environmentVars: { ELIZA_API_TOKEN: "encrypted-token" },
      }),
    ).toMatchObject({
      organization_id: "22222222-2222-4222-8222-222222222222",
      user_id: "33333333-3333-4333-8333-333333333333",
      agent_name: "bnancy",
      character_id: "44444444-4444-4444-8444-444444444444",
      execution_tier: "custom",
      status: "pending",
      database_status: "none",
      agent_config: {
        bio: "A real caller-owned persona",
        __agentCharacterOwnership: "reuse-existing",
      },
      environment_vars: { ELIZA_API_TOKEN: "encrypted-token" },
    });
  });

  test("seeds the canonical cloud character when a managed create brings no persona", async () => {
    const { buildAgentSandboxInsertValues } = await import(".././eliza-sandbox.ts?actual");
    const { buildDefaultAgentCharacterConfig } = await import(".././default-agent-character");
    const seed = buildDefaultAgentCharacterConfig();

    for (const executionTier of ["shared", "dedicated-always"] as const) {
      const config = buildAgentSandboxInsertValues({
        organizationId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        agentName: "bnancy",
        executionTier,
      }).agent_config as Record<string, unknown>;

      expect(config.system).toBe(seed.system);
      expect(config.bio).toEqual(seed.bio);
      expect(config.style).toEqual(seed.style);
      expect(config.messageExamples).toEqual(seed.messageExamples);
      // The agent's own name stays in the `agent_name` column so a later rename
      // still reaches every reader; the seed must not pin it into the config.
      expect(config.name).toBeUndefined();
      expect(config.system).not.toBe("You are bnancy, a helpful assistant.");
    }
  });

  test("leaves a caller-supplied or character-linked create unseeded", async () => {
    const { agentConfigForProvision, buildAgentSandboxInsertValues } = await import(
      ".././eliza-sandbox.ts?actual"
    );
    const base = {
      organizationId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
      agentName: "bnancy",
      executionTier: "shared" as const,
    };

    expect(
      buildAgentSandboxInsertValues({
        ...base,
        agentConfig: { system: "You are bnancy, the caller's own persona." },
      }).agent_config,
    ).toEqual({ system: "You are bnancy, the caller's own persona." });

    expect(
      buildAgentSandboxInsertValues({
        ...base,
        agentConfig: { character: { system: "nested caller persona" } },
      }).agent_config,
    ).toEqual({ character: { system: "nested caller persona" } });

    expect(
      buildAgentSandboxInsertValues({
        ...base,
        characterId: "44444444-4444-4444-8444-444444444444",
      }).agent_config,
    ).toEqual({ __agentCharacterOwnership: "reuse-existing" });

    const custom = buildAgentSandboxInsertValues({
      ...base,
      dockerImage: "ghcr.io/dexploarer/bnancy:latest",
      executionTier: "custom",
    });
    expect(custom.agent_config).toEqual({});
    expect(agentConfigForProvision(custom)).toBeUndefined();
  });
});

describe("computeManagedAgentDbEnv (#8696 local agent state)", () => {
  const DB = "postgres://shared.example/railway";

  test("local-state agent gets ELIZA_MANAGED_DATABASE_URL and NO DATABASE_URL", async () => {
    const { computeManagedAgentDbEnv } = await import(".././eliza-sandbox.ts?actual");
    const env = computeManagedAgentDbEnv({ ELIZA_AGENT_LOCAL_STATE: "1" }, DB);
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ELIZA_MANAGED_DATABASE_URL).toBe(DB);
  });

  test("existing agent (no flag) keeps the shared DATABASE_URL injection", async () => {
    const { computeManagedAgentDbEnv } = await import(".././eliza-sandbox.ts?actual");
    const env = computeManagedAgentDbEnv({}, DB);
    expect(env.DATABASE_URL).toBe(DB);
    expect(env.ELIZA_MANAGED_DATABASE_URL).toBeUndefined();
  });

  test("caller-supplied DATABASE_URL is preserved; managed exposed separately", async () => {
    const { computeManagedAgentDbEnv } = await import(".././eliza-sandbox.ts?actual");
    const env = computeManagedAgentDbEnv({ DATABASE_URL: "postgres://own.example/db" }, DB);
    // dbEnv never clobbers the caller's DATABASE_URL (it is spread first in create()).
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ELIZA_MANAGED_DATABASE_URL).toBe(DB);
  });

  // The merges below mirror create()'s `{ ...callerEnv, ...computeManagedAgentDbEnv(...) }`
  // (eliza-sandbox.ts) — the whole locality design depends on this spread order,
  // which the pure-function tests above don't exercise.
  test("create() merge: a caller DATABASE_URL survives while the shared DB rides ELIZA_MANAGED_DATABASE_URL", async () => {
    const { computeManagedAgentDbEnv } = await import(".././eliza-sandbox.ts?actual");
    const callerEnv = { DATABASE_URL: "postgres://own.example/db" };
    const merged = { ...callerEnv, ...computeManagedAgentDbEnv(callerEnv, DB) };
    expect(merged.DATABASE_URL).toBe("postgres://own.example/db");
    expect(merged.ELIZA_MANAGED_DATABASE_URL).toBe(DB);
  });

  test("create() merge: a local-state agent ends with NO DATABASE_URL and the shared DB on the managed key", async () => {
    const { computeManagedAgentDbEnv } = await import(".././eliza-sandbox.ts?actual");
    const callerEnv = { ELIZA_AGENT_LOCAL_STATE: "1" };
    const merged = { ...callerEnv, ...computeManagedAgentDbEnv(callerEnv, DB) };
    expect(merged.DATABASE_URL).toBeUndefined();
    expect(merged.ELIZA_MANAGED_DATABASE_URL).toBe(DB);
  });
});

describe("buildRuntimeBootstrapAgent persona seed", () => {
  type BootstrapRec = Pick<AgentSandbox, "id" | "agent_name" | "agent_config" | "environment_vars">;
  type BootstrapAgent = {
    name: string;
    system: string;
    bio: string[];
    style?: { all?: string[]; chat?: string[]; post?: string[] };
  };

  async function buildBootstrap(rec: BootstrapRec): Promise<BootstrapAgent> {
    const { ElizaSandboxService } = await import(".././eliza-sandbox.ts?actual");
    const svc = new ElizaSandboxService() as unknown as {
      buildRuntimeBootstrapAgent(r: BootstrapRec): BootstrapAgent;
    };
    return svc.buildRuntimeBootstrapAgent(rec);
  }

  const baseRec: BootstrapRec = {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    agent_name: "bnancy",
    agent_config: {},
    environment_vars: {},
  };

  test("seeds a name-aware identity when agent_config has no system/bio", async () => {
    const agent = await buildBootstrap(baseRec);
    // Real identity (no generic deflection) that matches the agent's own name —
    // not the placeholder, and not a claim to be a differently-named character.
    expect(agent.name).toBe("bnancy");
    expect(agent.system).toBe("You are bnancy, a helpful assistant.");
    expect(agent.bio).toEqual(["bnancy is a helpful Eliza Cloud agent."]);
    expect(agent.system).not.toBe("Concise cloud agent.");
    expect(agent.system).not.toContain("Eliza - not an assistant");
    expect(agent.style).toBeUndefined();
  });

  test("preserves a real persona supplied in agent_config", async () => {
    const agent = await buildBootstrap({
      ...baseRec,
      agent_config: {
        system: "You are shared-nancy.",
        bio: ["a real bio"],
        style: { all: ["terse"] },
      },
    });
    expect(agent.system).toBe("You are shared-nancy.");
    expect(agent.bio).toEqual(["a real bio"]);
    expect(agent.style).toEqual({ all: ["terse"] });
  });

  test("boots a freshly created agent on the seeded default character", async () => {
    const { buildAgentSandboxInsertValues } = await import(".././eliza-sandbox.ts?actual");
    const { buildDefaultAgentCharacterConfig } = await import(".././default-agent-character");
    const seed = buildDefaultAgentCharacterConfig();

    const agent = await buildBootstrap({
      ...baseRec,
      agent_config: buildAgentSandboxInsertValues({
        organizationId: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        agentName: "bnancy",
        executionTier: "dedicated-always",
      }).agent_config as Record<string, unknown>,
    });

    // The stub fallback is now unreachable for a fresh agent: the persona comes
    // from the row, while the NAME still comes from the agent_name column.
    expect(agent.name).toBe("bnancy");
    expect(agent.system).toBe(seed.system);
    expect(agent.bio).toEqual(seed.bio as string[]);
    expect(agent.style).toEqual(seed.style as { all?: string[] });
    expect(agent.system).not.toBe("You are bnancy, a helpful assistant.");
  });
});

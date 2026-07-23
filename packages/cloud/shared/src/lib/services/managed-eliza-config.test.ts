// Exercises managed eliza config behavior with deterministic cloud-shared lib fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("./api-keys", () => ({
  apiKeysService: {
    createForAgent: async () => ({ plainKey: "agent-api-key" }),
  },
}));

describe("managed Eliza environment", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.ELIZA_CLOUD_URL;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.ELIZA_CLOUD_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
  });

  test("sets public base url to the managed agent subdomain when missing", async () => {
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "elizacloud.ai";
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
    });

    expect(result.environmentVars.PUBLIC_BASE_URL).toBe("https://cloud-agent-1.elizacloud.ai");
  });

  test("replaces local and tunnel public base urls before provisioning", async () => {
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "elizacloud.ai";
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const localResult = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        PUBLIC_BASE_URL: "http://localhost:3000",
      },
    });
    const tunnelResult = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        PUBLIC_BASE_URL: "https://worm-represent-leisure-inquiry.trycloudflare.com",
      },
    });

    expect(localResult.environmentVars.PUBLIC_BASE_URL).toBe("https://cloud-agent-1.elizacloud.ai");
    expect(tunnelResult.environmentVars.PUBLIC_BASE_URL).toBe(
      "https://cloud-agent-1.elizacloud.ai",
    );
  });

  test("preserves a caller-pinned custom public base url", async () => {
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "elizacloud.ai";
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        PUBLIC_BASE_URL: "https://bnancy.example.com/",
      },
    });

    expect(result.environmentVars.PUBLIC_BASE_URL).toBe("https://bnancy.example.com/");
  });

  test("replaces unresolved public base url placeholders", async () => {
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "elizacloud.ai";
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        PUBLIC_BASE_URL: "https://(new-agent-id).elizacloud.ai",
      },
    });

    expect(result.environmentVars.PUBLIC_BASE_URL).toBe("https://cloud-agent-1.elizacloud.ai");
  });

  test("pins managed containers to their cloud agent id for waifu chat JWT scope", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
    });

    expect(result.environmentVars.ELIZA_CLOUD_AGENT_ID).toBe("cloud-agent-1");
    expect(result.environmentVars.WAIFU_ELIZA_CLOUD_AGENT_ID).toBe("cloud-agent-1");
  });

  test("preserves waifu-provided hosted UI enablement", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        ELIZA_UI_ENABLE: "true",
      },
    });

    expect(result.environmentVars.ELIZA_UI_ENABLE).toBe("true");
  });

  test("preserves waifu chat auth and frame env for hosted token pages", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        WAIFU_CHAT_ACCESS_JWT_SECRET: "waifu-chat-secret",
        WAIFU_CHAT_FRAME_ANCESTORS: "https://waifu.fun https://staging.waifu.fun",
      },
    });

    expect(result.environmentVars.WAIFU_CHAT_ACCESS_JWT_SECRET).toBe("waifu-chat-secret");
    expect(result.environmentVars.WAIFU_CHAT_FRAME_ANCESTORS).toBe(
      "https://waifu.fun https://staging.waifu.fun",
    );
  });

  test("pins embeddings to the elizacloud Worker base so /embeddings never 503s", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
    });

    // Embeddings must target the elizacloud Worker base (which has a working
    // /embeddings route), NOT fall back to the BitRouter text base (no
    // /embeddings → 503). By default it matches the general cloud API base.
    expect(result.environmentVars.ELIZAOS_CLOUD_EMBEDDING_URL).toBeTruthy();
    expect(result.environmentVars.ELIZAOS_CLOUD_EMBEDDING_URL).toBe(
      result.environmentVars.ELIZAOS_CLOUD_BASE_URL,
    );
  });

  test("honors an explicit per-agent embedding URL override", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        ELIZAOS_CLOUD_EMBEDDING_URL: "https://custom.example.com/api/v1",
      },
    });

    expect(result.environmentVars.ELIZAOS_CLOUD_EMBEDDING_URL).toBe(
      "https://custom.example.com/api/v1",
    );
  });

  test("defaults new agents to local in-container state + lean chat plugins (#8696/#8434)", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
    });

    // Local agent-state on the persistent volume — no shared-DB hot path.
    expect(result.environmentVars.ELIZA_AGENT_LOCAL_STATE).toBe("1");
    expect(result.environmentVars.PGLITE_DATA_DIR).toBe("/root/.eliza/.pgdata");
    // Lean chat plugin set for fast cold-start.
    expect(result.environmentVars.ELIZA_PLUGIN_SET).toBe("lean-chat");
  });

  test("honors escape hatches: shared DB + custom plugin set + custom pglite dir", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        ELIZA_AGENT_LOCAL_STATE: "0",
        ELIZA_PLUGIN_SET: "full",
        PGLITE_DATA_DIR: "/custom/pgdata",
      },
    });

    expect(result.environmentVars.ELIZA_AGENT_LOCAL_STATE).toBe("0");
    expect(result.environmentVars.ELIZA_PLUGIN_SET).toBe("full");
    expect(result.environmentVars.PGLITE_DATA_DIR).toBe("/custom/pgdata");
  });

  test("strips an inherited control-plane DATABASE_URL so a local-state agent stays off shared Postgres (#8783/#8696)", async () => {
    // The provisioning Worker/daemon carries its OWN DATABASE_URL in process env,
    // which spreads in via existingEnv. If it leaks through, the agent's
    // resolveEffectiveDbProvider selects Postgres and silently overrides
    // ELIZA_AGENT_LOCAL_STATE=1 — forcing every local-state agent back onto the
    // shared Railway DB (the latency + blast-radius regression #8779 had to
    // restore the strip for). The strip is THE mechanism; guard it directly.
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        DATABASE_URL: "postgres://control-plane/leak",
        ELIZA_MANAGED_DATABASE_URL: "postgres://stale/x",
      },
    });

    expect(result.environmentVars.DATABASE_URL).toBeUndefined();
    expect(result.environmentVars.ELIZA_MANAGED_DATABASE_URL).toBeUndefined();
    // ...and the local-state intent survives the strip.
    expect(result.environmentVars.ELIZA_AGENT_LOCAL_STATE).toBe("1");
  });

  test("pins both embedding dimensions to 1536 so the storage column and the cloud probe agree (#8769)", async () => {
    // Pinning EMBEDDING_DIMENSION + ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS=1536 makes
    // the cloud TEXT_EMBEDDING handler EMIT 1536-wide vectors. plugin-sql does NOT
    // read these vars; the storage column is sized at boot by the model-length
    // probe (runtime.ensureEmbeddingDimension). Both must agree on 1536 or the boot
    // probe snaps the column to a width the handler's output won't match —
    // re-introducing "Skipping embedding insert: dimension mismatch" (#8769).
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
    });

    expect(result.environmentVars.EMBEDDING_DIMENSION).toBe("1536");
    expect(result.environmentVars.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS).toBe("1536");
  });

  test("honors explicit per-agent embedding-dimension overrides", async () => {
    const { prepareManagedElizaBaseEnvironment } = await import("./managed-eliza-config");

    const result = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-1",
      userId: "user-1",
      agentSandboxId: "cloud-agent-1",
      existingEnv: {
        EMBEDDING_DIMENSION: "768",
        ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: "768",
      },
    });

    expect(result.environmentVars.EMBEDDING_DIMENSION).toBe("768");
    expect(result.environmentVars.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS).toBe("768");
  });
});

describe("applyManagedAgentInferenceEnvDefaults (#8434)", () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    delete process.env.ELIZA_CLOUD_URL;
    delete process.env.ELIZAOS_CLOUD_BASE_URL;
    delete process.env.ELIZA_CLOUD_API_BASE_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
  });

  test("returns all 5 inference keys with 1536-d embedding defaults on an empty env", async () => {
    const { applyManagedAgentInferenceEnvDefaults } = await import("./managed-eliza-config");

    const result = applyManagedAgentInferenceEnvDefaults({});

    expect(Object.keys(result).sort()).toEqual([
      "ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS",
      "ELIZAOS_CLOUD_EMBEDDING_URL",
      "ELIZAOS_CLOUD_LARGE_MODEL",
      "ELIZAOS_CLOUD_SMALL_MODEL",
      "EMBEDDING_DIMENSION",
    ]);
    expect(result.EMBEDDING_DIMENSION).toBe("1536");
    expect(result.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS).toBe("1536");
    expect(result.ELIZAOS_CLOUD_EMBEDDING_URL).toBeTruthy();
    expect(result.ELIZAOS_CLOUD_SMALL_MODEL).toBeTruthy();
    expect(result.ELIZAOS_CLOUD_LARGE_MODEL).toBeTruthy();
  });

  test("preserves explicit per-agent overrides", async () => {
    const { applyManagedAgentInferenceEnvDefaults } = await import("./managed-eliza-config");

    const result = applyManagedAgentInferenceEnvDefaults({
      EMBEDDING_DIMENSION: "768",
      ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS: "768",
      ELIZAOS_CLOUD_EMBEDDING_URL: "https://custom.example.com/api/v1",
      ELIZAOS_CLOUD_SMALL_MODEL: "custom-small",
      ELIZAOS_CLOUD_LARGE_MODEL: "custom-large",
    });

    expect(result.EMBEDDING_DIMENSION).toBe("768");
    expect(result.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS).toBe("768");
    expect(result.ELIZAOS_CLOUD_EMBEDDING_URL).toBe("https://custom.example.com/api/v1");
    expect(result.ELIZAOS_CLOUD_SMALL_MODEL).toBe("custom-small");
    expect(result.ELIZAOS_CLOUD_LARGE_MODEL).toBe("custom-large");
  });

  test("spreading the helper heals a stale upgrade env that lacks EMBEDDING_DIMENSION", async () => {
    // Mirrors the blue/green fleet-upgrade path (eliza-sandbox.ts): an agent
    // provisioned BEFORE the dimension pin landed carries a stale env with no
    // EMBEDDING_DIMENSION. Spreading the helper on top backfills "1536" (so the
    // 1536-d cloud vectors stop landing in a dim_384 column) while preserving the
    // agent's other env verbatim.
    const { applyManagedAgentInferenceEnvDefaults } = await import("./managed-eliza-config");

    const staleUpgradeEnv: Record<string, string> = {
      DATABASE_URL: "postgres://agent/own-db",
      ELIZA_API_TOKEN: "agent_existingtoken",
      ELIZAOS_CLOUD_API_KEY: "sk-existing",
      ELIZA_AGENT_LOCAL_STATE: "1",
      PGLITE_DATA_DIR: "/root/.eliza/.pgdata",
      ELIZA_PLUGIN_SET: "lean-chat",
    };

    const healed = {
      ...staleUpgradeEnv,
      ...applyManagedAgentInferenceEnvDefaults(staleUpgradeEnv),
    };

    // The inference defaults are backfilled...
    expect(healed.EMBEDDING_DIMENSION).toBe("1536");
    expect(healed.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS).toBe("1536");
    expect(healed.ELIZAOS_CLOUD_EMBEDDING_URL).toBeTruthy();
    expect(healed.ELIZAOS_CLOUD_SMALL_MODEL).toBeTruthy();
    expect(healed.ELIZAOS_CLOUD_LARGE_MODEL).toBeTruthy();
    // ...and the stored env is preserved verbatim (no key rotation, no DB strip,
    // no state flip — the whole point of the narrow helper).
    expect(healed.DATABASE_URL).toBe("postgres://agent/own-db");
    expect(healed.ELIZA_API_TOKEN).toBe("agent_existingtoken");
    expect(healed.ELIZAOS_CLOUD_API_KEY).toBe("sk-existing");
    expect(healed.ELIZA_AGENT_LOCAL_STATE).toBe("1");
    expect(healed.PGLITE_DATA_DIR).toBe("/root/.eliza/.pgdata");
    expect(healed.ELIZA_PLUGIN_SET).toBe("lean-chat");
  });
});

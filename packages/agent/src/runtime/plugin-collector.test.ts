/**
 * Covers the public plugin-collector surface: alias resolution, exported
 * registry maps, and collectPluginNames() branches that specialized sibling
 * suites do not own (allow-list normalization, connectors vs channels,
 * first-winning load reasons, installs, feature/entries gating, Google
 * Workspace signals, orchestrator/gitpathologist, store-build and
 * cloud-container defaults). Deterministic env snapshots over in-memory
 * ElizaConfig; no live model and no plugin module load.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  CORE_PLUGINS,
  MOBILE_VIEW_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "./core-plugins.ts";
import {
  CHANNEL_PLUGIN_MAP,
  collectPluginNames,
  MODEL_PROVIDER_PLUGIN_NAMES,
  OPTIONAL_PLUGIN_MAP,
  type PluginLoadReasons,
  PROVIDER_PLUGIN_MAP,
  resolvePluginPackageAlias,
} from "./plugin-collector.ts";

const ENV_KEYS = [
  "ELIZA_PLATFORM",
  "ELIZA_LOCAL_LLAMA",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_DISABLE_LOCAL_EMBEDDINGS",
  "ELIZA_BUILD_VARIANT",
  "ELIZA_AGENT_ORCHESTRATOR",
  "ELIZA_PLUGIN_SET",
  "ELIZA_DEFAULT_AGENT_TYPE",
  "ELIZA_ACP_DEFAULT_AGENT",
  "ELIZA_AGENT_SELECTION_STRATEGY",
  "ELIZA_MAX_CONCURRENT_SPAWNS",
  "ELIZA_DISABLE_PERSONAL_ASSISTANT",
  "ELIZA_GITPATHOLOGIST",
  "ELIZA_WORKSPACE_DIR",
  "ELIZA_TELEGRAM_STANDALONE_BOT",
  "ELIZA_LIFEOPS_PASSIVE_CONNECTORS",
  "LIFEOPS_PASSIVE_CONNECTORS",
  "ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS",
  "ELIZAOS_CLOUD_USE_EMBEDDINGS",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "CEREBRAS_API_KEY",
  "OLLAMA_BASE_URL",
  "ZAI_API_KEY",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  // Keep gitpathologist off unless a test opts in — this checkout is a git repo
  // and the package may resolve, which would otherwise auto-load the plugin.
  process.env.ELIZA_GITPATHOLOGIST = "0";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const emptyConfig = (): ElizaConfig => ({}) as ElizaConfig;

describe("resolvePluginPackageAlias", () => {
  it("rewrites each known legacy package id to its current first-party name", () => {
    expect(resolvePluginPackageAlias("@elizaos/plugin-coding-agent")).toBe(
      "@elizaos/plugin-coding-tools",
    );
    expect(resolvePluginPackageAlias("@elizaos/plugin-shell")).toBe(
      "@elizaos/plugin-coding-tools",
    );
    expect(resolvePluginPackageAlias("@elizaos/plugin-discord-local")).toBe(
      "@elizaos/plugin-discord",
    );
    expect(
      resolvePluginPackageAlias("@elizaos/plugin-telegram-standalone"),
    ).toBe("@elizaos/plugin-telegram");
    expect(resolvePluginPackageAlias("@homunculuslabs/plugin-zai")).toBe(
      "@elizaos/plugin-zai",
    );
  });

  it("passes through unknown names, including the empty string", () => {
    expect(resolvePluginPackageAlias("@elizaos/plugin-openai")).toBe(
      "@elizaos/plugin-openai",
    );
    expect(resolvePluginPackageAlias("not-a-plugin")).toBe("not-a-plugin");
    expect(resolvePluginPackageAlias("")).toBe("");
  });
});

describe("exported plugin maps", () => {
  it("exposes generated channel ids as first-party packages", () => {
    expect(CHANNEL_PLUGIN_MAP.discord).toBe("@elizaos/plugin-discord");
    expect(CHANNEL_PLUGIN_MAP.telegram).toBe("@elizaos/plugin-telegram");
    expect(CHANNEL_PLUGIN_MAP.googlechat).toBe(
      "@elizaos/plugin-google-workspace",
    );
    expect(CHANNEL_PLUGIN_MAP.twitter).toBe("@elizaos/plugin-x");
    expect(CHANNEL_PLUGIN_MAP.x).toBe("@elizaos/plugin-x");
  });

  it("keeps MODEL_PROVIDER_PLUGIN_NAMES as the set of PROVIDER_PLUGIN_MAP values", () => {
    const fromMap = new Set(Object.values(PROVIDER_PLUGIN_MAP));
    expect(MODEL_PROVIDER_PLUGIN_NAMES).toEqual(fromMap);
    expect(MODEL_PROVIDER_PLUGIN_NAMES.has("@elizaos/plugin-openai")).toBe(
      true,
    );
    expect(MODEL_PROVIDER_PLUGIN_NAMES.has("@elizaos/plugin-elizacloud")).toBe(
      true,
    );
  });

  it("layers the legacy host-owned short-id tail under the generated map", () => {
    expect(OPTIONAL_PLUGIN_MAP.obsidian).toBe("@elizaos/plugin-obsidian");
    expect(OPTIONAL_PLUGIN_MAP.x402).toBe("@elizaos/plugin-x402");
    expect(OPTIONAL_PLUGIN_MAP.repoprompt).toBe("@elizaos/plugin-repoprompt");
    expect(OPTIONAL_PLUGIN_MAP.wallet).toBe("@elizaos/plugin-wallet");
  });
});

describe("collectPluginNames seed and reasons", () => {
  it("seeds CORE_PLUGINS plus the every-platform view plugins on a blank config", () => {
    const names = collectPluginNames(emptyConfig());
    for (const plugin of CORE_PLUGINS) {
      expect(names.has(plugin)).toBe(true);
    }
    for (const plugin of MOBILE_VIEW_PLUGINS) {
      expect(names.has(plugin)).toBe(true);
    }
    expect(names.has("agent-orchestrator")).toBe(false);
    expect(names.has("@elizaos/plugin-personal-assistant")).toBe(false);
  });

  it("records the first winning reason and ignores later adds of the same name", () => {
    const reasons: PluginLoadReasons = new Map();
    collectPluginNames(
      {
        plugins: {
          allow: ["@elizaos/plugin-sql", "discord"],
        },
      } as ElizaConfig,
      reasons,
    );

    expect(reasons.get("@elizaos/plugin-sql")).toBe("CORE_PLUGINS");
    expect(reasons.get("@elizaos/plugin-discord")).toBe(
      'plugins.allow["discord"]',
    );
    expect(reasons.get("@elizaos/plugin-calendar")).toBe(
      "MOBILE_VIEW_PLUGINS (home-tile view)",
    );
  });

  it("still returns a load set when the optional reasons map is omitted", () => {
    const names = collectPluginNames(emptyConfig());
    expect(names.size).toBeGreaterThan(0);
  });
});

describe("collectPluginNames allow-list normalization", () => {
  it("treats an empty allow-list as a no-op, not an exclusive whitelist", () => {
    const names = collectPluginNames({
      plugins: { allow: [] },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-sql")).toBe(true);
  });

  it("expands short ids, plugin- prefixes, app- prefixes, and already-scoped names", () => {
    const names = collectPluginNames({
      plugins: {
        allow: [
          "discord",
          "plugin-openai",
          "app-custom-surface",
          "@elizaos/plugin-slack",
        ],
      },
    } as ElizaConfig);

    expect(names.has("@elizaos/plugin-discord")).toBe(true);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
    expect(names.has("@elizaos/app-custom-surface")).toBe(true);
    expect(names.has("@elizaos/plugin-slack")).toBe(true);
    expect(names.has("discord")).toBe(false);
    expect(names.has("plugin-openai")).toBe(false);
  });

  it("rewrites legacy allow-list package ids through the alias table", () => {
    const names = collectPluginNames({
      plugins: { allow: ["@elizaos/plugin-shell"] },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(true);
    expect(names.has("@elizaos/plugin-shell")).toBe(false);
  });
});

describe("collectPluginNames connectors and channels", () => {
  it("loads a mapped connector and skips null, array, primitive, and disabled rows", () => {
    const names = collectPluginNames({
      connectors: {
        discord: { enabled: true },
        slack: { enabled: false },
        telegram: null,
        whatsapp: ["not-a-config"],
        matrix: "yes",
        notAChannel: { enabled: true },
      },
    } as unknown as ElizaConfig);

    expect(names.has("@elizaos/plugin-discord")).toBe(true);
    expect(names.has("@elizaos/plugin-slack")).toBe(false);
    expect(names.has("@elizaos/plugin-telegram")).toBe(false);
    expect(names.has("@elizaos/plugin-whatsapp")).toBe(false);
    expect(names.has("@elizaos/plugin-matrix")).toBe(false);
    expect(names.has("notAChannel")).toBe(false);
    expect(names.has("@elizaos/plugin-notAChannel")).toBe(false);
  });

  it("falls back to config.channels when connectors is absent", () => {
    const names = collectPluginNames({
      channels: {
        telegram: { token: "x" },
      },
    } as unknown as ElizaConfig);
    expect(names.has("@elizaos/plugin-telegram")).toBe(true);
  });

  it("does not treat an empty googlechat object as a configured connector", () => {
    const names = collectPluginNames({
      connectors: {
        googlechat: {},
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-google-workspace")).toBe(false);
  });

  it("loads google-workspace from a googlechat connector that carries a service account", () => {
    const names = collectPluginNames({
      connectors: {
        googlechat: {
          enabled: true,
          serviceAccount: "sa@example.com",
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-google-workspace")).toBe(true);
  });
});

describe("collectPluginNames model-provider env keys", () => {
  it("adds a provider plugin when its env key is a non-empty string", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const names = collectPluginNames(emptyConfig());
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });

  it("ignores blank or whitespace-only provider env values", () => {
    process.env.OPENAI_API_KEY = "   ";
    const names = collectPluginNames(emptyConfig());
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
  });

  it("does not treat ELIZAOS_CLOUD_API_KEY as a direct PROVIDER_PLUGIN_MAP load", () => {
    process.env.ELIZAOS_CLOUD_API_KEY = "cloud-test";
    const names = collectPluginNames(emptyConfig());
    // Cloud env is handled by topology / cloudEffectivelyEnabled, not the
    // per-key PROVIDER_PLUGIN_MAP loop (that loop skips the two cloud keys).
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(true);
  });

  it("skips an env-selected provider that plugins.entries explicitly disables", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const names = collectPluginNames({
      plugins: {
        entries: {
          openai: { enabled: false },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
  });

  it("when one provider is explicitly enabled, other env keys do not auto-load", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const names = collectPluginNames({
      plugins: {
        entries: {
          openai: { enabled: true },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
    expect(names.has("@elizaos/plugin-anthropic")).toBe(false);
  });
});

describe("collectPluginNames plugins.entries and features", () => {
  it("requires enabled===true for optional-core plugins and adds others unless enabled===false", () => {
    expect(OPTIONAL_CORE_PLUGINS).toContain("@elizaos/plugin-obsidian");

    const names = collectPluginNames({
      plugins: {
        entries: {
          obsidian: {},
          "custom-extra": {},
          "also-custom": { enabled: false },
          skip: null,
          skipBool: true,
        },
      },
    } as unknown as ElizaConfig);

    expect(names.has("@elizaos/plugin-obsidian")).toBe(false);
    expect(names.has("@elizaos/plugin-custom-extra")).toBe(true);
    expect(names.has("@elizaos/plugin-also-custom")).toBe(false);
  });

  it("loads an optional-core plugin only when its entry is explicitly enabled", () => {
    const names = collectPluginNames({
      plugins: {
        entries: {
          obsidian: { enabled: true },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-obsidian")).toBe(true);
  });

  it("resolves a connector key in plugins.entries through CHANNEL_PLUGIN_MAP", () => {
    const names = collectPluginNames({
      plugins: {
        entries: {
          telegram: { enabled: true },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-telegram")).toBe(true);
  });

  it("honors feature flags as true, nested enabled objects, and ignores disabled/unknown", () => {
    const names = collectPluginNames({
      features: {
        vision: true,
        x402: { enabled: true },
        obsidian: { enabled: false },
        notAFeature: true,
        shellEnabled: true,
      },
    } as unknown as ElizaConfig);

    expect(names.has("@elizaos/plugin-vision")).toBe(true);
    expect(names.has("@elizaos/plugin-x402")).toBe(true);
    expect(names.has("@elizaos/plugin-obsidian")).toBe(false);
    expect(names.has("notAFeature")).toBe(false);
    expect(names.has("@elizaos/plugin-notAFeature")).toBe(false);
  });

  it("treats a feature object without enabled=false as on, including an empty array", () => {
    const names = collectPluginNames({
      features: {
        x402: {},
        obsidian: [],
      },
    } as unknown as ElizaConfig);
    expect(names.has("@elizaos/plugin-x402")).toBe(true);
    expect(names.has("@elizaos/plugin-obsidian")).toBe(true);
  });
});

describe("collectPluginNames x402, installs, and feature gates", () => {
  it("loads x402 from config.x402.enabled", () => {
    const names = collectPluginNames({
      x402: { enabled: true },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-x402")).toBe(true);
  });

  it("does not load x402 when the section is present but not enabled", () => {
    const names = collectPluginNames({
      x402: { enabled: false },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-x402")).toBe(false);
  });

  it("adds plugins.installs records and rewrites legacy package ids", () => {
    const names = collectPluginNames({
      plugins: {
        installs: {
          "@elizaos/plugin-coding-agent": { version: "1.0.0" },
          "@elizaos/plugin-music": { version: "1.0.0" },
          "skip-me": null,
          "also-skip": "1.0.0",
        },
      },
    } as unknown as ElizaConfig);

    expect(names.has("@elizaos/plugin-coding-tools")).toBe(true);
    expect(names.has("@elizaos/plugin-coding-agent")).toBe(false);
    expect(names.has("@elizaos/plugin-music")).toBe(true);
    expect(names.has("skip-me")).toBe(false);
    expect(names.has("also-skip")).toBe(false);
  });

  it("drops coding-tools when features.shellEnabled is false, even if allow-listed", () => {
    const names = collectPluginNames({
      features: { shellEnabled: false },
      plugins: { allow: ["@elizaos/plugin-coding-tools"] },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(false);
  });

  it("strips local-execution plugins from a store build even when requested", () => {
    process.env.ELIZA_BUILD_VARIANT = "store";
    process.env.ELIZA_AGENT_ORCHESTRATOR = "1";
    const names = collectPluginNames({
      plugins: { allow: ["@elizaos/plugin-coding-tools"] },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-coding-tools")).toBe(false);
    expect(names.has("agent-orchestrator")).toBe(false);
    expect(names.has("@elizaos/plugin-agent-orchestrator")).toBe(false);
  });

  it("honors an explicit plugins.entries disable after other paths added the package", () => {
    const names = collectPluginNames({
      plugins: {
        allow: ["discord"],
        entries: {
          discord: { enabled: false },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-discord")).toBe(false);
  });
});

describe("collectPluginNames Google Workspace and calendar companion", () => {
  it("keeps scheduling whenever calendar is present", () => {
    const names = collectPluginNames(emptyConfig());
    expect(names.has("@elizaos/plugin-calendar")).toBe(true);
    expect(names.has("@elizaos/plugin-scheduling")).toBe(true);
  });

  it("loads google-workspace from the full GOOGLE_CLIENT_* trio", () => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REDIRECT_URI = "https://example.com/oauth/callback";
    const names = collectPluginNames(emptyConfig());
    expect(names.has("@elizaos/plugin-google-workspace")).toBe(true);
  });

  it("does not infer Workspace from an incomplete GOOGLE_CLIENT_* trio", () => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    const names = collectPluginNames(emptyConfig());
    expect(names.has("@elizaos/plugin-google-workspace")).toBe(false);
  });

  it("loads Workspace from an explicit plugins.entries enable", () => {
    const names = collectPluginNames({
      plugins: {
        entries: {
          "google-workspace": { enabled: true },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-google-workspace")).toBe(true);
  });

  it("lets an explicit Workspace disable win over OAuth env", () => {
    process.env.GOOGLE_CLIENT_ID = "client";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REDIRECT_URI = "https://example.com/oauth/callback";
    const names = collectPluginNames({
      plugins: {
        entries: {
          "google-workspace": { enabled: false },
        },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-google-workspace")).toBe(false);
  });
});

describe("collectPluginNames orchestrator and gitpathologist", () => {
  it("loads the orchestrator from agents.list[0] when that field is a boolean", () => {
    const enabled = collectPluginNames({
      agents: { list: [{ agentOrchestrator: true }] },
    } as ElizaConfig);
    expect(enabled.has("agent-orchestrator")).toBe(true);

    const disabled = collectPluginNames({
      agents: { list: [{ agentOrchestrator: false }] },
    } as ElizaConfig);
    expect(disabled.has("agent-orchestrator")).toBe(false);
  });

  it("falls through to agents.defaults when the first entry omits the field", () => {
    const names = collectPluginNames({
      agents: {
        list: [{ name: "default" }],
        defaults: { agentOrchestrator: true },
      },
    } as ElizaConfig);
    expect(names.has("agent-orchestrator")).toBe(true);
  });

  it.each(["1", "true", "yes"] as const)(
    "loads the orchestrator when ELIZA_AGENT_ORCHESTRATOR=%s",
    (raw) => {
      process.env.ELIZA_AGENT_ORCHESTRATOR = raw;
      expect(collectPluginNames(emptyConfig()).has("agent-orchestrator")).toBe(
        true,
      );
    },
  );

  it.each(["0", "false", "no"] as const)(
    "keeps the orchestrator off when ELIZA_AGENT_ORCHESTRATOR=%s",
    (raw) => {
      process.env.ELIZA_AGENT_ORCHESTRATOR = raw;
      process.env.ELIZA_CLOUD_PROVISIONED = "1";
      expect(collectPluginNames(emptyConfig()).has("agent-orchestrator")).toBe(
        false,
      );
    },
  );

  it("treats a non-empty ELIZA_DEFAULT_AGENT_TYPE as an orchestrator request", () => {
    process.env.ELIZA_DEFAULT_AGENT_TYPE = "coding";
    expect(collectPluginNames(emptyConfig()).has("agent-orchestrator")).toBe(
      true,
    );
  });

  it("ignores whitespace-only orchestrator hint env keys", () => {
    process.env.ELIZA_MAX_CONCURRENT_SPAWNS = "  ";
    expect(collectPluginNames(emptyConfig()).has("agent-orchestrator")).toBe(
      false,
    );
  });

  it("loads gitpathologist when agents.list[0].gitpathologist is true", () => {
    delete process.env.ELIZA_GITPATHOLOGIST;
    const names = collectPluginNames({
      agents: { list: [{ gitpathologist: true }] },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-gitpathologist")).toBe(true);
  });

  it("honors an explicit gitpathologist config false over the env opt-in", () => {
    process.env.ELIZA_GITPATHOLOGIST = "1";
    const names = collectPluginNames({
      agents: { list: [{ gitpathologist: false }] },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-gitpathologist")).toBe(false);
  });

  it.each(["1", "true", "yes"] as const)(
    "loads gitpathologist when ELIZA_GITPATHOLOGIST=%s",
    (raw) => {
      process.env.ELIZA_GITPATHOLOGIST = raw;
      expect(
        collectPluginNames(emptyConfig()).has("@elizaos/plugin-gitpathologist"),
      ).toBe(true);
    },
  );
});

describe("collectPluginNames cloud-container and inference policy", () => {
  it("adds pty and cli-inference on a provisioned cloud container and drops local inference", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    const names = collectPluginNames(emptyConfig());
    expect(names.has("@elizaos/plugin-pty")).toBe(true);
    expect(names.has("@elizaos/plugin-cli-inference")).toBe(true);
    expect(names.has("@elizaos/plugin-local-inference")).toBe(false);
    expect(names.has("@elizaos/plugin-personal-assistant")).toBe(false);
    expect(names.has("agent-orchestrator")).toBe(true);
  });

  it("keeps local inference on a cloud container when ELIZA_LOCAL_LLAMA=1", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_LOCAL_LLAMA = "1";
    const names = collectPluginNames(emptyConfig());
    expect(names.has("@elizaos/plugin-local-inference")).toBe(true);
  });

  it("does not treat ELIZA_CLOUD_PROVISIONED=true as the container marker", () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "true";
    const names = collectPluginNames(emptyConfig());
    expect(names.has("@elizaos/plugin-pty")).toBe(false);
    expect(names.has("agent-orchestrator")).toBe(false);
  });

  it("strips every model-provider surface on a remote runtime, including env-selected ones", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const names = collectPluginNames({
      deploymentTarget: { runtime: "remote", provider: "remote" },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
    expect(names.has("@elizaos/plugin-local-inference")).toBe(false);
  });

  it("strips remote providers under legacy local-only inference even when their env keys are set", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const names = collectPluginNames({
      cloud: { inferenceMode: "local" },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
    expect(names.has("@elizaos/plugin-elizacloud")).toBe(false);
    expect(names.has("@elizaos/plugin-local-inference")).toBe(true);
  });

  it("also treats cloud.services.inference=false as legacy local-only inference", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const names = collectPluginNames({
      cloud: { services: { inference: false } },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(false);
    expect(names.has("@elizaos/plugin-local-inference")).toBe(true);
  });

  it("keeps a direct provider when cloud is disabled but llmText is still routed", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const names = collectPluginNames({
      cloud: { enabled: false },
      deploymentTarget: { runtime: "local" },
      serviceRouting: {
        llmText: { backend: "openai", transport: "direct" },
      },
    } as ElizaConfig);
    expect(names.has("@elizaos/plugin-openai")).toBe(true);
  });

  it("does not treat [REDACTED] or vault:// cloud keys as serving credentials", () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.ELIZAOS_CLOUD_API_KEY = "[REDACTED]";
    const redacted = collectPluginNames({
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    } as ElizaConfig);
    expect(redacted.has("@elizaos/plugin-local-inference")).toBe(true);

    process.env.ELIZAOS_CLOUD_API_KEY = "vault://providers.elizacloud.api-key";
    const vaulted = collectPluginNames({
      serviceRouting: {
        llmText: { backend: "elizacloud", transport: "cloud-proxy" },
      },
    } as ElizaConfig);
    expect(vaulted.has("@elizaos/plugin-local-inference")).toBe(true);
  });
});

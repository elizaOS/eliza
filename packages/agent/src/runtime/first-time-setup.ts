/**
 * First-run interactive CLI onboarding flow.
 *
 * Detects whether this is the first run (no agent name configured)
 * and walks the user through:
 *
 *   1. Welcome banner
 *   2. Name selector (4 random + Custom)
 *   3. Catchphrase / writing-style selector
 *   3.5. Runtime selection (Cloud vs Local)
 *   4. Model provider
 *   5. Wallet setup (local runtime only)
 *   6. Skills registry (local runtime only)
 *   7. GitHub access (local runtime only)
 *   8. Persist agent + style + provider + embedding config
 *
 * Extracted from eliza.ts to reduce file size.
 *
 * @module first-time-setup
 */

import type { StylePreset } from "@elizaos/shared";
import {
  buildDefaultElizaCloudServiceRouting,
  buildElizaCloudServiceRoute,
  formatError,
  getStylePresets,
  migrateLegacyRuntimeConfig,
} from "@elizaos/shared";
import { persistConfigEnv } from "../api/config-env.js";
import {
  CLOUD_EVM_ADDRESS_ENV_KEY,
  CLOUD_SOLANA_ADDRESS_ENV_KEY,
  WALLET_SOURCE_EVM_ENV_KEY,
  WALLET_SOURCE_SOLANA_ENV_KEY,
} from "../api/wallet.js";
import { type ElizaConfig, saveElizaConfig } from "../config/config.js";
import { isCloudWalletEnabled } from "../config/feature-flags.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { CloudOnboardingResult } from "@elizaos/plugin-elizacloud";
import { pickRandomNames } from "./onboarding-names.js";

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

type FirstTimeSetupCloudResult = CloudOnboardingResult;
const DEFAULT_ONBOARDING_AGENT_NAME = getStylePresets()[0]?.name ?? "Eliza";

export function applyFirstTimeSetupTopology(
  config: ElizaConfig,
  args: {
    isCloudRuntime: boolean;
    selectedProviderId?: string;
    cloudOnboardingResult?: FirstTimeSetupCloudResult | null;
    useLocalEmbeddings?: boolean;
  },
): ElizaConfig {
  const linkedAccounts = {
    ...(config.linkedAccounts ?? {}),
  } as NonNullable<ElizaConfig["linkedAccounts"]>;
  const serviceRouting = {
    ...(config.serviceRouting ?? {}),
  } as NonNullable<ElizaConfig["serviceRouting"]>;
  const cloudOnboardingResult = args.cloudOnboardingResult ?? null;

  if (cloudOnboardingResult?.apiKey?.trim()) {
    linkedAccounts.elizacloud = {
      status: "linked",
      source: "oauth",
    };
  }

  const shouldUseCloudInference = args.selectedProviderId === "elizacloud";

  if (shouldUseCloudInference) {
    serviceRouting.llmText = buildElizaCloudServiceRoute();
  } else if (args.selectedProviderId?.trim()) {
    serviceRouting.llmText = {
      backend: args.selectedProviderId.trim(),
      transport: "direct",
    };
  }

  if (args.isCloudRuntime || shouldUseCloudInference) {
    Object.assign(
      serviceRouting,
      buildDefaultElizaCloudServiceRouting({
        base: serviceRouting,
        includeInference: shouldUseCloudInference,
        excludeServices: args.useLocalEmbeddings ? ["embeddings"] : undefined,
      }),
    );
  }

  return {
    ...config,
    deploymentTarget: args.isCloudRuntime
      ? { runtime: "cloud", provider: "elizacloud" }
      : { runtime: "local" },
    linkedAccounts:
      Object.keys(linkedAccounts).length > 0 ? linkedAccounts : undefined,
    serviceRouting:
      Object.keys(serviceRouting).length > 0 ? serviceRouting : undefined,
    ...(cloudOnboardingResult
      ? {
          cloud: {
            ...config.cloud,
            apiKey: cloudOnboardingResult.apiKey,
            baseUrl: cloudOnboardingResult.baseUrl,
            ...(cloudOnboardingResult.agentId
              ? { agentId: cloudOnboardingResult.agentId }
              : {}),
          },
        }
      : {}),
  };
}

// @clack/prompts is loaded lazily so the packaged desktop app (which never
// runs interactive onboarding) does not crash when the package is unavailable.
type ClackModule = typeof import("@clack/prompts");
let _clack: ClackModule | null = null;
async function loadClack(): Promise<ClackModule> {
  if (!_clack) {
    try {
      _clack = await import("@clack/prompts");
    } catch (err) {
      throw new Error(
        `@clack/prompts is required for first-time setup but could not be loaded: ${(err as Error).message ?? err}. ` +
          `Install it with: bun add @clack/prompts`,
      );
    }
  }
  return _clack;
}

/**
 * Cancel the onboarding flow and exit cleanly.
 * Extracted to avoid duplicating the cancel+exit pattern 7 times.
 */
function cancelOnboarding(): never {
  // _clack is guaranteed to be loaded by the time onboarding calls this.
  _clack?.cancel("Maybe next time!");
  process.exit(0);
}

/**
 * Read whether the runtime config holds cached cloud-wallet descriptors.
 * Uses defensive accessors because `wallet.cloud` is introduced by the
 * cloud-wallet module (Phase 3) and may not exist in older configs.
 */
function hasCloudWalletBinding(config: ElizaConfig): boolean {
  const walletSection = config.wallet;
  if (!walletSection || typeof walletSection !== "object") return false;
  const cloud = walletSection.cloud;
  if (!cloud || typeof cloud !== "object") return false;
  const cloudObj = cloud as Record<string, unknown>;
  return Boolean(cloudObj.evm || cloudObj.solana);
}

function readCloudWalletAddress(
  config: ElizaConfig,
  chain: "evm" | "solana",
): string | null {
  const walletSection = config.wallet;
  const descriptor = walletSection?.cloud?.[chain];
  if (!descriptor || typeof descriptor !== "object") return null;

  const raw =
    typeof descriptor.walletAddress === "string"
      ? descriptor.walletAddress
      : typeof descriptor.address === "string"
        ? descriptor.address
        : null;
  return raw?.trim() ? raw.trim() : null;
}

/**
 * Read the user's saved primary wallet source selection from config.
 * Returns { evm, solana } where each can be:
 *  - "cloud": user explicitly chose cloud
 *  - "local": user explicitly chose local
 *  - null: user has not made an explicit choice (should auto-bind to cloud)
 */
function readUserPrimarySelection(config: ElizaConfig): {
  evm: "local" | "cloud" | null;
  solana: "local" | "cloud" | null;
} {
  const wallet = config.wallet;
  const raw = wallet?.primary;
  const result: {
    evm: "local" | "cloud" | null;
    solana: "local" | "cloud" | null;
  } = { evm: null, solana: null };
  if (raw) {
    if (raw.evm === "cloud" || raw.evm === "local") {
      result.evm = raw.evm;
    }
    if (raw.solana === "cloud" || raw.solana === "local") {
      result.solana = raw.solana;
    }
  }
  return result;
}

/**
 * When cloud mode + cloud wallet are both on and the cloud cache holds
 * descriptors, mark the runtime env so plugin-wallet binds
 * against the cloud signer rather than a local private key. Writes
 * `WALLET_SOURCE_EVM=cloud` / `WALLET_SOURCE_SOLANA=cloud` and the resolved
 * cloud wallet addresses to config.env (durable across restarts) and to
 * `process.env` (visible to the in-flight runtime).
 *
 * IMPORTANT: Only binds to cloud if the user has not explicitly selected
 * local as primary for that chain. This preserves user-made primary selection
 * changes across restarts.
 *
 * No-ops if `ENABLE_CLOUD_WALLET` is off or if the cache is empty.
 */
export async function bindCloudProvider(config: ElizaConfig): Promise<void> {
  if (!isCloudWalletEnabled()) return;
  if (!hasCloudWalletBinding(config)) return;

  const walletSection = config.wallet;
  const cloud = walletSection?.cloud ?? {};
  const evmAddress = readCloudWalletAddress(config, "evm");
  const solanaAddress = readCloudWalletAddress(config, "solana");
  const userPrimary = readUserPrimarySelection(config);
  const shouldBindEvm = Boolean(cloud.evm) && userPrimary.evm !== "local";
  const shouldBindSolana =
    Boolean(cloud.solana) && userPrimary.solana !== "local";

  if (
    shouldBindEvm &&
    evmAddress &&
    process.env[CLOUD_EVM_ADDRESS_ENV_KEY] !== evmAddress
  ) {
    await persistConfigEnv(CLOUD_EVM_ADDRESS_ENV_KEY, evmAddress);
  }
  if (
    shouldBindSolana &&
    solanaAddress &&
    process.env[CLOUD_SOLANA_ADDRESS_ENV_KEY] !== solanaAddress
  ) {
    await persistConfigEnv(CLOUD_SOLANA_ADDRESS_ENV_KEY, solanaAddress);
  }

  if (shouldBindEvm && process.env[WALLET_SOURCE_EVM_ENV_KEY] !== "cloud") {
    await persistConfigEnv(WALLET_SOURCE_EVM_ENV_KEY, "cloud");
  }
  if (
    shouldBindSolana &&
    process.env[WALLET_SOURCE_SOLANA_ENV_KEY] !== "cloud"
  ) {
    await persistConfigEnv(WALLET_SOURCE_SOLANA_ENV_KEY, "cloud");
  }
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

export async function runFirstTimeSetup(
  config: ElizaConfig,
): Promise<ElizaConfig> {
  const agentEntry = config.agents?.list?.[0];
  const hasName = Boolean(agentEntry?.name || config.ui?.assistant?.name);

  // hasName short-circuits the interactive onboarding prompts but must NOT
  // bypass runtime-rebind steps (e.g. cloud-wallet → WALLET_SOURCE_*). Those
  // need to re-run every restart so cloud state changes made while the agent
  // was offline are reflected in env before plugins load.
  if (hasName) {
    await bindCloudProvider(config);
    return config;
  }

  // Only prompt when stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) return config;

  // Load @clack/prompts lazily — only needed for interactive CLI onboarding.
  const clack = await loadClack();

  // ── Step 1: Welcome ────────────────────────────────────────────────────
  clack.intro("WELCOME TO ELIZA!");

  // ── Step 2: Name ───────────────────────────────────────────────────────
  const randomNames = pickRandomNames(4);

  const nameChoice = await clack.select({
    message: "Hey, quick check, what should I be called?",
    options: [
      ...randomNames.map((n) => ({ value: n, label: n })),
      { value: "_custom_", label: "Custom...", hint: "type your own" },
    ],
  });

  if (clack.isCancel(nameChoice)) cancelOnboarding();

  let name: string;

  if (nameChoice === "_custom_") {
    const customName = await clack.text({
      message: "OK, what should I be called?",
      placeholder: "Choose a name",
    });

    if (clack.isCancel(customName)) cancelOnboarding();

    name = customName.trim() || DEFAULT_ONBOARDING_AGENT_NAME;
  } else {
    name = nameChoice;
  }

  clack.log.message(`♡♡${name}♡♡: Oh that's right, I'm ${name}!`);

  // ── Step 3: Catchphrase / writing style ────────────────────────────────
  const styleChoice = await clack.select({
    message: `${name}: Now... how do I like to talk again?`,
    options: getStylePresets().map((preset: StylePreset) => ({
      value: preset.id,
      label: preset.catchphrase,
      hint: preset.hint,
    })),
  });

  if (clack.isCancel(styleChoice)) cancelOnboarding();

  const chosenTemplate = getStylePresets().find(
    (p: StylePreset) => p.id === styleChoice,
  );

  // ── Step 3.5: Runtime selection (Cloud vs Local) ───────────────────────
  // Present the user with a choice of where to run their agent. Cloud mode
  // skips the local AI provider, wallet, and GitHub steps.
  let cloudOnboardingResult:
    | CloudOnboardingResult
    | null = null;
  let isCloudMode = false;

  const runtimeChoice = await clack.select({
    message: `${name}: Where should I live?`,
    options: [
      {
        value: "cloud",
        label: "☁️  Eliza Cloud (recommended)",
        hint: "zero setup — hosted, always online",
      },
      {
        value: "local",
        label: "💻  Run locally",
        hint: "full control — runs on this machine",
      },
      {
        value: "later",
        label: "⏭️  Decide later",
        hint: "start local, switch to cloud anytime",
      },
    ],
  });

  if (clack.isCancel(runtimeChoice)) cancelOnboarding();

  if (runtimeChoice === "later") {
    // User deferred the decision — continue with local setup (steps 4–7).
    clack.log.info(
      "No problem! Starting with local setup. You can switch to cloud anytime with `eliza cloud connect`.",
    );
  } else if (runtimeChoice === "cloud") {
    const { runCloudOnboarding } = await import(
      "@elizaos/plugin-elizacloud"
    );
    cloudOnboardingResult = await runCloudOnboarding(
      clack,
      name,
      chosenTemplate,
    );

    if (cloudOnboardingResult?.agentId) {
      isCloudMode = true;
      clack.log.success(`${name} is now running in the cloud! ☁️`);
    } else if (cloudOnboardingResult) {
      // Auth succeeded but no agent provisioned — save auth for later
      clack.log.info(
        "Cloud auth saved. You can provision later with `eliza cloud connect`.",
      );
    } else {
      // Cloud flow cancelled / failed — fall back to local
      clack.log.info("No worries! Setting up locally instead.");
    }
  }

  // ── Step 4: Model provider ───────────────────────────────────────────────
  // Runtime location and inference provider are independent. Cloud-hosted
  // agents can still use direct providers, and local agents can still use
  // Eliza Cloud as the inference backend when linked.
  let selectedProviderId: string | undefined;
  let providerEnvKey: string | undefined;
  let providerApiKey: string | undefined;

  // Snapshot whether wallet keys already exist BEFORE onboarding touches
  // process.env, so the persistence block later can guard against
  // overwriting pre-existing values.
  const hasEvmKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
  const hasSolKey = Boolean(process.env.SOLANA_PRIVATE_KEY?.trim());

  const PROVIDER_OPTIONS = [
    ...(cloudOnboardingResult?.apiKey
      ? ([
          {
            id: "elizacloud",
            label: "Eliza Cloud",
            envKey: null,
            detectKeys: [] as string[],
            hint: "use linked Eliza Cloud inference",
          },
        ] as const)
      : []),
    {
      id: "anthropic",
      label: "Anthropic (Claude)",
      envKey: "ANTHROPIC_API_KEY",
      detectKeys: ["ANTHROPIC_API_KEY"],
      hint: "sk-ant-...",
    },
    {
      id: "openai",
      label: "OpenAI (GPT)",
      envKey: "OPENAI_API_KEY",
      detectKeys: ["OPENAI_API_KEY"],
      hint: "sk-...",
    },
    {
      id: "openrouter",
      label: "OpenRouter",
      envKey: "OPENROUTER_API_KEY",
      detectKeys: ["OPENROUTER_API_KEY"],
      hint: "sk-or-...",
    },
    {
      id: "vercel-ai-gateway",
      label: "Vercel AI Gateway",
      envKey: "AI_GATEWAY_API_KEY",
      detectKeys: ["AI_GATEWAY_API_KEY", "AIGATEWAY_API_KEY"],
      hint: "aigw_...",
    },
    {
      id: "gemini",
      label: "Google Gemini",
      envKey: "GOOGLE_GENERATIVE_AI_API_KEY",
      detectKeys: [
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "GOOGLE_API_KEY",
        "GEMINI_API_KEY",
      ],
      hint: "AI...",
    },
    {
      id: "grok",
      label: "xAI (Grok)",
      envKey: "XAI_API_KEY",
      detectKeys: ["XAI_API_KEY"],
      hint: "xai-...",
    },
    {
      id: "groq",
      label: "Groq",
      envKey: "GROQ_API_KEY",
      detectKeys: ["GROQ_API_KEY"],
      hint: "gsk_...",
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      envKey: "DEEPSEEK_API_KEY",
      detectKeys: ["DEEPSEEK_API_KEY"],
      hint: "sk-...",
    },
    {
      id: "zai",
      label: "z.ai",
      envKey: "ZAI_API_KEY",
      detectKeys: ["ZAI_API_KEY", "Z_AI_API_KEY"],
      hint: "",
    },
    {
      id: "moonshot",
      label: "Kimi / Moonshot",
      envKey: "MOONSHOT_API_KEY",
      detectKeys: ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
      hint: "sk-...",
    },
    {
      id: "mistral",
      label: "Mistral",
      envKey: "MISTRAL_API_KEY",
      detectKeys: ["MISTRAL_API_KEY"],
      hint: "",
    },
    {
      id: "together",
      label: "Together AI",
      envKey: "TOGETHER_API_KEY",
      detectKeys: ["TOGETHER_API_KEY"],
      hint: "",
    },
    {
      id: "ollama",
      label: "Ollama (local, free)",
      envKey: "OLLAMA_BASE_URL",
      detectKeys: ["OLLAMA_BASE_URL"],
      hint: "http://localhost:11434",
    },
  ] as const;

  // Detect if any provider key is already configured
  const detectedProvider = PROVIDER_OPTIONS.find((p) =>
    p.detectKeys.some((key) => process.env[key]?.trim()),
  );

  if (detectedProvider) {
    selectedProviderId = detectedProvider.id;
    providerEnvKey = detectedProvider.envKey ?? undefined;
    providerApiKey = detectedProvider.detectKeys
      .map((key) => process.env[key]?.trim())
      .find((value): value is string => Boolean(value));
    clack.log.success(
      `Found existing ${detectedProvider.label} key in environment (${detectedProvider.envKey})`,
    );
  } else {
    const providerChoice = await clack.select({
      message: `${name}: One more thing — which AI provider should I use?`,
      options: [
        ...PROVIDER_OPTIONS.map((p) => ({
          value: p.id,
          label: p.label,
          hint:
            p.id === "ollama"
              ? "no API key needed"
              : p.id === "elizacloud"
                ? "bundled cloud inference"
                : undefined,
        })),
        {
          value: "_skip_",
          label: "Skip for now",
          hint: "set an API key later via env or config",
        },
      ],
    });

    if (clack.isCancel(providerChoice)) cancelOnboarding();

    if (providerChoice !== "_skip_") {
      const chosen = PROVIDER_OPTIONS.find((p) => p.id === providerChoice);
      if (chosen) {
        selectedProviderId = chosen.id;
        providerEnvKey = chosen.envKey ?? undefined;

        if (chosen.id === "elizacloud") {
          clack.log.info("Using linked Eliza Cloud inference.");
        } else if (chosen.id === "ollama") {
          // Ollama just needs a base URL, default to localhost
          const ollamaUrl = await clack.text({
            message: "Ollama base URL:",
            placeholder: "http://localhost:11434",
            defaultValue: "http://localhost:11434",
          });

          if (clack.isCancel(ollamaUrl)) cancelOnboarding();

          providerApiKey = ollamaUrl.trim() || "http://localhost:11434";
        } else {
          const apiKeyInput = await clack.password({
            message: `Paste your ${chosen.label} API key:`,
          });

          if (clack.isCancel(apiKeyInput)) cancelOnboarding();

          providerApiKey = apiKeyInput.trim();
        }
      }
    }
  }

  // ── Steps 5–7: Local-runtime-only setup ─────────────────────────────────
  // Wallet and GitHub prompts stay local-only for now. Runtime target no
  // longer implies a specific inference provider, but these device-bound
  // setup steps still only make sense for local runs.
  if (!isCloudMode) {
    // ── Step 4b: Embedding model preset ────────────────────────────────────
    // (Simplified: always use the standard/reliable model preset. No user choice.)

    // ── Step 5: Wallet setup ───────────────────────────────────────────────
    // Offer to generate or import wallets for EVM and Solana. Keys are
    // stored in config.env and process.env, making them available to
    // plugins at runtime.
    const { generateWalletKeys, importWallet, setSolanaWalletEnv } =
      await import("../api/wallet.js");

    // hasEvmKey and hasSolKey are hoisted above the if (!isCloudMode) block
    // so they're also available in the persistence section.
    if (!hasEvmKey || !hasSolKey) {
      const walletAction = await clack.select({
        message: `${name}: Do you want me to set up crypto wallets? (for trading, NFTs, DeFi)`,
        options: [
          {
            value: "generate",
            label: "Generate new wallets",
            hint: "creates fresh EVM + Solana keypairs",
          },
          {
            value: "import",
            label: "Import existing wallets",
            hint: "paste your private keys",
          },
          {
            value: "skip",
            label: "Skip for now",
            hint: "wallets can be added later",
          },
        ],
      });

      if (clack.isCancel(walletAction)) cancelOnboarding();

      if (walletAction === "generate") {
        const keys = generateWalletKeys();

        if (!hasEvmKey) {
          process.env.EVM_PRIVATE_KEY = keys.evmPrivateKey;
          clack.log.success(`Generated EVM wallet: ${keys.evmAddress}`);
        }
        if (!hasSolKey) {
          setSolanaWalletEnv(keys.solanaPrivateKey);
          clack.log.success(`Generated Solana wallet: ${keys.solanaAddress}`);
        }
      } else if (walletAction === "import") {
        // EVM import
        if (!hasEvmKey) {
          const evmKeyInput = await clack.password({
            message: "Paste your EVM private key (0x... hex, or skip):",
          });

          if (!clack.isCancel(evmKeyInput) && evmKeyInput.trim()) {
            const result = importWallet("evm", evmKeyInput.trim());
            if (result.success) {
              clack.log.success(`Imported EVM wallet: ${result.address}`);
            } else {
              clack.log.warn(`EVM import failed: ${result.error}`);
            }
          }
        }

        // Solana import
        if (!hasSolKey) {
          const solKeyInput = await clack.password({
            message: "Paste your Solana private key (base58, or skip):",
          });

          if (!clack.isCancel(solKeyInput) && solKeyInput.trim()) {
            const result = importWallet("solana", solKeyInput.trim());
            if (result.success) {
              clack.log.success(`Imported Solana wallet: ${result.address}`);
            } else {
              clack.log.warn(`Solana import failed: ${result.error}`);
            }
          }
        }
      }
      // "skip" — do nothing
    }

    // ── Step 6: Skills Registry (ClawHub default) ──────────────────────────
    const hasSkillsRegistry = Boolean(
      process.env.SKILLS_REGISTRY?.trim() ||
        process.env.CLAWHUB_REGISTRY?.trim(),
    );
    const _hasSkillsmpKey = Boolean(process.env.SKILLSMP_API_KEY?.trim());
    if (!hasSkillsRegistry) {
      process.env.SKILLS_REGISTRY = "https://clawhub.ai";
    }

    // ── Step 7: GitHub access (for coding agents, issue management) ─────────
    const hasGithubToken = Boolean(process.env.GITHUB_TOKEN?.trim());
    const hasGithubOAuth = Boolean(process.env.GITHUB_OAUTH_CLIENT_ID?.trim());
    if (!hasGithubToken) {
      const options: Array<{ value: string; label: string; hint?: string }> = [
        {
          value: "skip",
          label: "Skip for now",
          hint: "you can add this later",
        },
        {
          value: "pat",
          label: "Paste a Personal Access Token",
          hint: "github.com/settings/tokens",
        },
      ];
      if (hasGithubOAuth) {
        options.push({
          value: "oauth",
          label: "Use OAuth (authorize in browser)",
          hint: "recommended",
        });
      }

      const githubChoice = await clack.select({
        message:
          "Configure GitHub access? (needed for coding agents, issue management, PRs)",
        options,
      });

      if (!clack.isCancel(githubChoice) && githubChoice === "pat") {
        const tokenInput = await clack.password({
          message: "Paste your GitHub token (or skip):",
        });
        if (!clack.isCancel(tokenInput) && tokenInput.trim()) {
          process.env.GITHUB_TOKEN = tokenInput.trim();
          clack.log.success("GitHub token configured.");
        }
      } else if (!clack.isCancel(githubChoice) && githubChoice === "oauth") {
        clack.log.info(
          "GitHub OAuth will activate when coding agents need access.",
        );
      }
    }
  } // end if (!isCloudMode)

  // ── Step 8: Persist agent + style + provider + embedding config ─────────
  // Save the agent name and chosen personality template into config so that
  // the same character data is used regardless of whether the user onboarded
  // via CLI or GUI.  This ensures full parity between onboarding surfaces.
  const existingList: AgentConfig[] = config.agents?.list ?? [];
  const mainEntry: AgentConfig = existingList[0] ?? {
    id: "main",
    default: true,
  };
  const agentConfigEntry: AgentConfig = { ...mainEntry, name };

  // Apply the chosen style template to the agent config entry so the
  // personality is persisted — not just the name.
  if (chosenTemplate) {
    agentConfigEntry.bio = chosenTemplate.bio;
    agentConfigEntry.system = chosenTemplate.system;
    agentConfigEntry.style = chosenTemplate.style;
    agentConfigEntry.adjectives = chosenTemplate.adjectives;
    agentConfigEntry.postExamples = chosenTemplate.postExamples;
    agentConfigEntry.messageExamples = chosenTemplate.messageExamples;
  }

  const updatedList: AgentConfig[] = [
    agentConfigEntry,
    ...existingList.slice(1),
  ];

  const updated: ElizaConfig = {
    ...config,
    agents: {
      ...config.agents,
      list: updatedList,
    },
  };

  const topologyUpdated = applyFirstTimeSetupTopology(updated, {
    isCloudRuntime: isCloudMode,
    selectedProviderId,
    cloudOnboardingResult,
  });

  // Persist provider API keys and wallet keys in config.env so they survive
  // restarts. Initialise the env bucket once to avoid the repeated
  // `if (!config.env)` pattern.
  if (!topologyUpdated.env) topologyUpdated.env = {};
  const envBucket = topologyUpdated.env as Record<string, string>;

  if (providerEnvKey && providerApiKey) {
    envBucket[providerEnvKey] = providerApiKey;
    // Also set immediately in process.env for the current run
    process.env[providerEnvKey] = providerApiKey;
  }

  if (!isCloudMode) {
    if (process.env.EVM_PRIVATE_KEY && !hasEvmKey) {
      envBucket.EVM_PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
    }
    if (process.env.SOLANA_PRIVATE_KEY && !hasSolKey) {
      envBucket.SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
    }
    if (process.env.SKILLS_REGISTRY) {
      envBucket.SKILLS_REGISTRY = process.env.SKILLS_REGISTRY;
    }
    if (process.env.SKILLSMP_API_KEY) {
      envBucket.SKILLSMP_API_KEY = process.env.SKILLSMP_API_KEY;
    }
    if (process.env.GITHUB_TOKEN) {
      envBucket.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    }
    if (process.env.GITHUB_OAUTH_CLIENT_ID) {
      envBucket.GITHUB_OAUTH_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID;
    }
  }

  try {
    migrateLegacyRuntimeConfig(topologyUpdated as Record<string, unknown>);
    saveElizaConfig(topologyUpdated);
  } catch (err) {
    // Non-fatal: the agent can still start, but choices won't persist.
    clack.log.warn(`Could not save config: ${formatError(err)}`);
  }

  // If cloud-mode onboarding already left cloud-wallet descriptors in the
  // config (rare on first run, but possible when resuming a partial flow),
  // make sure plugin-wallet sees WALLET_SOURCE_*=cloud before
  // they load.
  try {
    await bindCloudProvider(topologyUpdated);
  } catch (err) {
    clack.log.warn(`Could not bind cloud wallet provider: ${formatError(err)}`);
  }

  clack.log.message(`${name}: ${styleChoice} Alright, that's me.`);
  clack.outro(
    isCloudMode ? "Your agent is live in the cloud! ☁️" : "Let's get started!",
  );

  return topologyUpdated;
}

import {
  type Character,
  defaultCharacterSystemTemplate,
  mergeCharacterDefaults,
} from "@elizaos/core";
import {
  getDefaultStylePreset,
  normalizeCharacterLanguage,
  resolveStylePresetByAvatarIndex,
  resolveStylePresetById,
  resolveStylePresetByName,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.js";
import {
  applyAdvancedCapabilitySettings,
  resolveAdvancedCapabilitiesEnabled,
} from "./advanced-capabilities-config.js";

/**
 * Build a Character object from the runtime ElizaConfig.
 *
 * The character is the initial runtime identity — name, bio, system prompt,
 * secrets, and capability settings. It is NOT the persisted agent record in the
 * database — not the config file — so we only provide sensible defaults here
 * for the initial setup.
 */
/** @internal Exported for testing. */
export function buildCharacterFromConfig(config: ElizaConfig): Character {
  const agentEntry = config.agents?.list?.[0];
  const uiConfig = (config.ui ?? {}) as {
    assistant?: { name?: string };
    avatarIndex?: number;
    language?: unknown;
    presetId?: string;
  };
  const language = normalizeCharacterLanguage(uiConfig.language);
  const configuredUiName = uiConfig.assistant?.name?.trim();
  const configuredAgentName = agentEntry?.name?.trim();
  // Prefer the UI-level assistant name when it diverges from the bundled
  // preset entry so renames take effect immediately across prompts/logging.
  const configuredName = configuredUiName || configuredAgentName;
  const bundledPreset =
    resolveStylePresetById(uiConfig.presetId, language) ??
    resolveStylePresetByAvatarIndex(uiConfig.avatarIndex, language) ??
    resolveStylePresetByName(configuredName, language) ??
    (configuredName ? undefined : getDefaultStylePreset(language));
  const name =
    configuredName ??
    bundledPreset?.name ??
    getDefaultStylePreset(language).name;

  const bio = agentEntry?.bio ??
    bundledPreset?.bio ?? [
      "{{name}} is an AI assistant powered by Eliza and elizaOS.",
    ];
  const systemPrompt =
    agentEntry?.system ??
    bundledPreset?.system ??
    defaultCharacterSystemTemplate;
  const style = agentEntry?.style ?? bundledPreset?.style;
  const adjectives = agentEntry?.adjectives ?? bundledPreset?.adjectives;
  const topics =
    agentEntry?.topics && agentEntry.topics.length > 0
      ? agentEntry.topics
      : bundledPreset?.topics;
  const postExamples = agentEntry?.postExamples ?? bundledPreset?.postExamples;
  const messageExamples =
    agentEntry?.messageExamples ?? bundledPreset?.messageExamples;
  const advancedMemory =
    agentEntry?.advancedMemory ??
    config.agents?.defaults?.advancedMemory ??
    true;
  const advancedCapabilitiesEnabled =
    resolveAdvancedCapabilitiesEnabled(config);
  const settings = applyAdvancedCapabilitySettings(
    {
      MEMORY_SUMMARY_MODEL_TYPE:
        process.env.MEMORY_SUMMARY_MODEL_TYPE?.trim() || "TEXT_SMALL",
      MEMORY_REFLECTION_MODEL_TYPE:
        process.env.MEMORY_REFLECTION_MODEL_TYPE?.trim() || "TEXT_LARGE",
    },
    advancedCapabilitiesEnabled,
  );

  // Collect secrets from process.env (API keys the plugins need)
  const secretKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "AI_GATEWAY_API_KEY",
    "AIGATEWAY_API_KEY",
    "AI_GATEWAY_BASE_URL",
    "AI_GATEWAY_SMALL_MODEL",
    "AI_GATEWAY_LARGE_MODEL",
    "AI_GATEWAY_EMBEDDING_MODEL",
    "AI_GATEWAY_EMBEDDING_DIMENSIONS",
    "AI_GATEWAY_IMAGE_MODEL",
    "AI_GATEWAY_TIMEOUT_MS",
    "OLLAMA_BASE_URL",
    "DISCORD_API_TOKEN",
    "DISCORD_APPLICATION_ID",
    "DISCORD_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_PHONE_NUMBER_ID",
    "WHATSAPP_AUTH_DIR",
    "WHATSAPP_SESSION_PATH",
    "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    "WHATSAPP_API_VERSION",
    "WHATSAPP_DM_POLICY",
    "WHATSAPP_GROUP_POLICY",
    "WHATSAPP_ALLOW_FROM",
    "WHATSAPP_GROUP_ALLOW_FROM",
    "TELEGRAM_ACCOUNT_PHONE",
    "TELEGRAM_ACCOUNT_APP_ID",
    "TELEGRAM_ACCOUNT_APP_HASH",
    "TELEGRAM_ACCOUNT_DEVICE_MODEL",
    "TELEGRAM_ACCOUNT_SYSTEM_VERSION",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_USER_TOKEN",
    "SIGNAL_ACCOUNT_NUMBER",
    "MSTEAMS_APP_ID",
    "MSTEAMS_APP_PASSWORD",
    "MATTERMOST_BOT_TOKEN",
    "MATTERMOST_BASE_URL",
    // ElizaCloud secrets
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_BASE_URL",
    "ELIZAOS_CLOUD_ENABLED",
    // Wallet / blockchain secrets
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "ALCHEMY_API_KEY",
    "HELIUS_API_KEY",
    "BIRDEYE_API_KEY",
    "SOLANA_RPC_URL",
    "X402_PRIVATE_KEY",
    "X402_NETWORK",
    "X402_PAY_TO",
    "X402_FACILITATOR_URL",
    "X402_MAX_PAYMENT_USD",
    "X402_MAX_TOTAL_USD",
    "X402_ENABLED",
    "X402_DB_PATH",
    // n8n workflow plugin (resolved by applyN8nConfigToEnv)
    "N8N_HOST",
    "N8N_API_KEY",
    // GitHub access for coding agent plugin
    "GITHUB_TOKEN",
    "GITHUB_OAUTH_CLIENT_ID",
  ];

  const secrets: Record<string, string> = {};
  for (const key of secretKeys) {
    const value = process.env[key];
    if (value?.trim()) {
      secrets[key] = value;
    }
  }

  // Normalise messageExamples to the {examples: [{name,content}]} shape
  // that @elizaos/core expects.  Config may contain EITHER format:
  //   OLD (preset/onboarding): [[{user, content}, ...], ...]
  //   NEW (@elizaos/core):     [{examples: [{name, content}, ...]}, ...]
  const mappedExamples = messageExamples?.map((item: unknown) => {
    // Already in new format — pass through
    if (
      item &&
      typeof item === "object" &&
      "examples" in (item as Record<string, unknown>)
    ) {
      return item as {
        examples: { name: string; content: { text: string } }[];
      };
    }
    // Old format — array of {user, content} entries
    const arr = item as {
      user?: string;
      name?: string;
      content: { text: string };
    }[];
    return {
      examples: arr.map((msg) => ({
        name: msg.name ?? msg.user ?? "",
        content: msg.content,
      })),
    };
  });

  // Capability hints — append short descriptions of features the runtime has
  // auto-enabled so the model knows about new actions/tools without requiring
  // the user to hand-edit the system prompt. Kept terse (one sentence per
  // capability) to stay out of the way of the preset's voice.
  const capabilityHints: string[] = [];
  const n8nMasterEnabled = config.n8n?.enabled !== false;
  const n8nExplicitlyDisabled =
    config.plugins?.entries?.["n8n-workflow"]?.enabled === false;
  const n8nCloudAuthed = Boolean(
    config.cloud?.apiKey && config.cloud?.enabled !== false,
  );
  const n8nLocalEnabled = config.n8n?.localEnabled !== false;
  if (
    n8nMasterEnabled &&
    !n8nExplicitlyDisabled &&
    (n8nCloudAuthed || n8nLocalEnabled)
  ) {
    capabilityHints.push(
      "You can create, activate, deactivate, and delete n8n workflows via natural language using the n8n workflow actions.",
    );
  }
  capabilityHints.push(
    "You have a persistent task manager and can create scheduled or one-off tasks when the user asks; do not claim you lack tasks, memory, persistence, or scheduling when those actions are available.",
  );
  const effectiveSystemPrompt =
    capabilityHints.length > 0
      ? `${systemPrompt}\n\n${capabilityHints.join("\n")}`
      : systemPrompt;

  return mergeCharacterDefaults({
    name,
    ...(agentEntry?.username ? { username: agentEntry.username } : {}),
    bio,
    system: effectiveSystemPrompt,
    ...(topics ? { topics } : {}),
    ...(style ? { style } : {}),
    ...(adjectives ? { adjectives } : {}),
    ...(postExamples ? { postExamples } : {}),
    ...(mappedExamples ? { messageExamples: mappedExamples } : {}),
    advancedMemory,
    settings,
    secrets,
  });
}

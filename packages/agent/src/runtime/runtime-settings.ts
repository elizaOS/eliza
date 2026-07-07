/**
 * Runtime settings projection for values plugins read through
 * `runtime.getSetting()`. The projection is intentionally pure so cold boot and
 * hot reload can share it without reintroducing drift between startup paths.
 */
import type { ElizaConfig } from "../config/config.ts";
import {
  collectConfigEnvVars,
  collectConnectorEnvVars,
} from "../config/env-vars.ts";

export interface RuntimeSettingsProjectionOptions {
  preferredProviderId?: string;
  visionModeSetting?: string;
  managedSkillsDir?: string;
  bundledSkillsDir?: string | null;
  workspaceSkillsDir?: string | null;
  walletSettings?: Record<string, string>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Returns true if the given env var key is safe to forward to runtime.settings.
 * Blocks blockchain private keys, secrets, passwords, tokens, credentials,
 * mnemonics, and seed phrases while allowing API keys that plugins need.
 */
export function isEnvKeyAllowedForForwarding(key: string): boolean {
  const upper = key.toUpperCase();
  if (upper === "ALLOW_NO_DATABASE") return false;
  if (upper.includes("PRIVATE_KEY")) return false;
  if (upper.startsWith("EVM_") || upper.startsWith("SOLANA_")) return false;
  if (/(SECRET|PASSWORD|CREDENTIAL|MNEMONIC|SEED_PHRASE)/i.test(key)) {
    return false;
  }
  if (/(ACCESS_TOKEN|REFRESH_TOKEN|SESSION_TOKEN|AUTH_TOKEN)$/i.test(key)) {
    return false;
  }
  if (
    upper === "ELIZAOS_CLOUD_API_KEY" ||
    upper === "ELIZAOS_CLOUD_ENABLED" ||
    upper === "ELIZAOS_CLOUD_BASE_URL" ||
    upper === "ELIZAOS_CLOUD_NANO_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEDIUM_MODEL" ||
    upper === "ELIZAOS_CLOUD_SMALL_MODEL" ||
    upper === "ELIZAOS_CLOUD_LARGE_MODEL" ||
    upper === "ELIZAOS_CLOUD_MEGA_MODEL" ||
    upper === "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL" ||
    upper === "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL" ||
    upper === "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL" ||
    upper === "ELIZAOS_CLOUD_PLANNER_MODEL"
  ) {
    return false;
  }
  return true;
}

export function buildRuntimeSettingsProjection(
  config: ElizaConfig,
  options: RuntimeSettingsProjectionOptions = {},
): Record<string, string> {
  const env = options.env ?? process.env;
  return {
    VALIDATION_LEVEL: "fast",
    ...(env.SECRET_SALT ? { ENCRYPTION_SALT: env.SECRET_SALT } : {}),
    ...Object.fromEntries(
      Object.entries(collectConfigEnvVars(config)).filter(([key]) =>
        isEnvKeyAllowedForForwarding(key),
      ),
    ),
    ...collectConnectorEnvVars(config),
    ...(options.preferredProviderId
      ? { MODEL_PROVIDER: options.preferredProviderId }
      : {}),
    ...(options.visionModeSetting
      ? { VISION_MODE: options.visionModeSetting }
      : {}),
    ...(options.walletSettings ?? {}),
    ...(typeof config.agents?.defaults?.adminEntityId === "string" &&
    config.agents.defaults.adminEntityId.trim().length > 0
      ? { ELIZA_ADMIN_ENTITY_ID: config.agents.defaults.adminEntityId.trim() }
      : {}),
    ...(config.agents?.defaults?.ownerContacts
      ? {
          ELIZA_OWNER_CONTACTS_JSON: JSON.stringify(
            config.agents.defaults.ownerContacts,
          ),
        }
      : {}),
    ...(config.agents?.defaults?.inboxTriage
      ? {
          ELIZA_INBOX_TRIAGE_CONFIG_JSON: JSON.stringify(
            config.agents.defaults.inboxTriage,
          ),
        }
      : {}),
    ...(config.roles?.connectorAdmins
      ? {
          ELIZA_ROLES_CONNECTOR_ADMINS_JSON: JSON.stringify(
            config.roles.connectorAdmins,
          ),
        }
      : {}),
    ...(config.skills?.allowBundled
      ? { SKILLS_ALLOWLIST: config.skills.allowBundled.join(",") }
      : {}),
    ...(config.skills?.denyBundled
      ? { SKILLS_DENYLIST: config.skills.denyBundled.join(",") }
      : {}),
    ...(options.managedSkillsDir
      ? { SKILLS_DIR: options.managedSkillsDir }
      : {}),
    ...(options.bundledSkillsDir
      ? { BUNDLED_SKILLS_DIRS: options.bundledSkillsDir }
      : {}),
    ...(options.workspaceSkillsDir
      ? { WORKSPACE_SKILLS_DIR: options.workspaceSkillsDir }
      : {}),
    ...(config.skills?.load?.extraDirs?.length
      ? { EXTRA_SKILLS_DIRS: config.skills.load.extraDirs.join(",") }
      : {}),
    ...(config.features?.vision === false
      ? { DISABLE_IMAGE_DESCRIPTION: "true" }
      : {}),
  };
}

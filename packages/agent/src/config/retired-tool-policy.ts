import { ElizaError } from "@elizaos/core";

const POLICY_KEYS = ["profile", "allow", "alsoAllow", "deny"] as const;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Empty historical lists and the unrestricted full profile impose no policy. */
export function unsupportedToolPolicyKeys(value: unknown): string[] {
  const policy = record(value);
  if (!policy) return [];
  return POLICY_KEYS.filter((key) => {
    const setting = policy[key];
    if (setting === undefined) return false;
    return key === "profile"
      ? setting !== "full"
      : !Array.isArray(setting) || setting.length > 0;
  });
}

function assertPolicy(value: unknown): void {
  if (unsupportedToolPolicyKeys(value).length > 0) {
    throw new ElizaError(
      "Configured tool-policy restrictions are not enforced by the runtime. Remove retired profile/allow/alsoAllow/deny settings and configure supported action authority instead.",
      { code: "CONFIG_TOOL_POLICY_UNSUPPORTED" },
    );
  }
  const fields = record(value);
  if (!fields) return;
  for (const override of Object.values(record(fields.byProvider) ?? {}))
    assertPolicy(override);
  assertPolicy(record(fields.sandbox)?.tools);
  assertPolicy(record(fields.subagents)?.tools);
}

/**
 * Setting names the runtime no longer reads, with the one name it reads now.
 * Some of them set sandbox, approval, permission or auth values. If a retired
 * name were ignored, the setting would fall back to its default, which can be
 * less restrictive. Boot stops instead and names the current setting.
 */
export const RETIRED_SETTING_NAMES: Readonly<Record<string, string>> = {
  ELIZA_API_AUTH_TOKEN: "ELIZA_API_TOKEN",
  CORS_ORIGINS: "ELIZA_ALLOWED_ORIGINS",
  SELFCONTROL_HOSTS_FILE_PATH: "WEBSITE_BLOCKER_HOSTS_FILE_PATH",
  ELIZA_CODEX_SANDBOX_MODE: "ELIZA_CODEX_ACP_SANDBOX_MODE",
  ELIZA_CODEX_APPROVAL_POLICY: "ELIZA_CODEX_ACP_APPROVAL_POLICY",
  ELIZA_CODEX_LANDLOCK: "ELIZA_CODEX_ACP_LANDLOCK",
  ACPX_TRANSPORT: "ELIZA_ACP_TRANSPORT",
  ELIZA_ACP_DEFAULT_APPROVAL: "ELIZA_DEFAULT_APPROVAL_PRESET",
  ELIZA_ACP_AGENT_SELECTION_STRATEGY: "ELIZA_AGENT_SELECTION_STRATEGY",
  ELIZA_ACP_PROMPT_TIMEOUT_MS: "ACPX_DEFAULT_TIMEOUT_MS",
  ELIZA_ACP_NO_TERMINAL: "ACPX_NO_TERMINAL",
  TASK_AGENT_CONNECTOR_ROLE_POLICY: "TASK_AGENT_ROLE_POLICY",
  ANTHROPIC_OAUTH_TOKEN: "CLAUDE_CODE_OAUTH_TOKEN",
  SHOULD_RESPOND_BYPASS_TYPES: "ALWAYS_RESPOND_CHANNELS",
  SHOULD_RESPOND_BYPASS_SOURCES: "ALWAYS_RESPOND_SOURCES",
  COMPUTERUSE_MODE: "COMPUTER_USE_MODE",
  ELIZA_COMPUTERUSE_MODE: "COMPUTER_USE_MODE",
  COMPUTERUSE_SANDBOX_BACKEND: "COMPUTER_USE_SANDBOX_BACKEND",
  ELIZA_COMPUTERUSE_SANDBOX_BACKEND: "COMPUTER_USE_SANDBOX_BACKEND",
  COMPUTERUSE_SANDBOX_IMAGE: "COMPUTER_USE_SANDBOX_IMAGE",
  ELIZA_COMPUTERUSE_SANDBOX_IMAGE: "COMPUTER_USE_SANDBOX_IMAGE",
  COMPUTERUSE_SANDBOX_RPC_URL: "COMPUTER_USE_SANDBOX_RPC_URL",
  COMPUTERUSE_SANDBOX_RPC_PORT: "COMPUTER_USE_SANDBOX_RPC_PORT",
  ZOOM_ACCESS_TOKEN: "ELIZA_ZOOM_ACCESS_TOKEN",
  IMESSAGE_BACKEND: "ELIZA_IMESSAGE_BACKEND",
  VISION_CAMERA_NAME: "CAMERA_NAME",
  VISION_PIXEL_CHANGE_THRESHOLD: "PIXEL_CHANGE_THRESHOLD",
  VISION_ENABLE_OBJECT_DETECTION: "ENABLE_OBJECT_DETECTION",
  VISION_ENABLE_POSE_DETECTION: "ENABLE_POSE_DETECTION",
  VISION_ENABLE_FACE_RECOGNITION: "ENABLE_FACE_RECOGNITION",
  VISION_TF_UPDATE_INTERVAL: "TF_UPDATE_INTERVAL",
  VISION_VLM_UPDATE_INTERVAL: "VLM_UPDATE_INTERVAL",
  VISION_TF_CHANGE_THRESHOLD: "TF_CHANGE_THRESHOLD",
  VISION_VLM_CHANGE_THRESHOLD: "VLM_CHANGE_THRESHOLD",
  VISION_SCREEN_CAPTURE_INTERVAL: "SCREEN_CAPTURE_INTERVAL",
  VISION_OCR_ENABLED: "OCR_ENABLED",
  VISION_MAX_MEMORY_USAGE_MB: "MAX_MEMORY_USAGE_MB",
};

/** Stop when process env, config env or character settings use a retired name. */
export function assertNoRetiredSettingNames(values: unknown): void {
  const fields = record(values);
  if (!fields) return;
  const found = Object.keys(RETIRED_SETTING_NAMES).filter((name) => {
    const value = fields[name];
    return value !== undefined && value !== null && String(value).trim() !== "";
  });
  if (found.length === 0) return;
  throw new ElizaError(
    `Retired setting names are set: ${found
      .map((name) => `${name} (rename to ${RETIRED_SETTING_NAMES[name]})`)
      .join(", ")}. The runtime no longer reads these names.`,
    { code: "CONFIG_RETIRED_SETTING_NAME" },
  );
}

/** Character JSON and restored characters carry the historical settings shape. */
export function assertNoRetiredCharacterToolRestrictions(
  settings: unknown,
): void {
  const fields = record(settings);
  if (!fields) return;
  assertNoRetiredSettingNames(fields);
  assertNoRetiredSettingNames(fields.secrets);
  assertNoRetiredSettingNames(fields.extra);
  assertPolicy(fields.tools);
  if (fields.toolProfile !== undefined)
    assertPolicy({ profile: fields.toolProfile });
}

/** Guard actual disk load/write as well as the separate settings schema. */
export function assertNoRetiredToolRestrictions(config: unknown): void {
  const root = record(config);
  if (!root) return;
  assertNoRetiredSettingNames(root.env);
  assertNoRetiredSettingNames(record(root.env)?.vars);
  assertPolicy(root.tools);
  const agents = record(root.agents)?.list;
  if (Array.isArray(agents))
    for (const agent of agents) {
      const entry = record(agent);
      assertPolicy(entry?.tools);
      assertNoRetiredCharacterToolRestrictions(entry?.settings);
    }
  // Connector schemas nest policies in accounts, groups, guilds, channels and
  // sender maps. Restrict this traversal to connector config, not plugin data.
  function connector(value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) connector(item);
      return;
    }
    const fields = record(value);
    if (!fields) return;
    assertPolicy(fields.tools);
    for (const senderPolicy of Object.values(
      record(fields.toolsBySender) ?? {},
    ))
      assertPolicy(senderPolicy);
    for (const [key, nested] of Object.entries(fields)) {
      if (key !== "tools" && key !== "toolsBySender") connector(nested);
    }
  }
  connector(root.connectors);
}

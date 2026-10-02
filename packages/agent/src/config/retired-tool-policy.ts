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

/** Character JSON and restored characters carry the historical settings shape. */
export function assertNoRetiredCharacterToolRestrictions(
  settings: unknown,
): void {
  const fields = record(settings);
  if (!fields) return;
  assertPolicy(fields.tools);
  if (fields.toolProfile !== undefined)
    assertPolicy({ profile: fields.toolProfile });
}

/** Guard actual disk load/write as well as the separate settings schema. */
export function assertNoRetiredToolRestrictions(config: unknown): void {
  const root = record(config);
  if (!root) return;
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

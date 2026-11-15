/** The agent host's ordinary assistant composition. Core loads only supplied plugins. */
import {
  type Character,
  ConnectorAccountManager,
  ElizaError,
  type Plugin,
  readActionAllowlist,
} from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import {
  autonomyCapabilities,
  createAdvancedMemoryPlugin,
  createAdvancedPlanningPlugin,
  createAssistantPlugin,
  documentsPlugin,
  relationshipsPlugin,
  secretsCapability,
  trajectoriesPlugin,
  trustCapability,
} from "@elizaos/plugin-assistant";

import { resolveOwnerChatCallerRole } from "../api/client-chat-admin.ts";
import { identityHttpPlugin } from "../api/identity-person-link-routes";
import { collectConfiguredDeniedPluginNames } from "./plugin-collector.ts";

const enabled = (value: unknown) => value === true || value === "true";

const ASSISTANT_PACKAGE_NAME = "@elizaos/plugin-assistant";
/** The member that installs the message service; a runtime cannot reply without it. */
const ASSISTANT_PLUGIN_NAME = "assistant";

/**
 * The host-built assistant plugins, minus every member the host's plugin deny
 * set (`plugins.deny` plus `ELIZA_SKIP_PLUGINS`) names. These are composed
 * here rather than resolved from the plugin list, so the resolver's deny step
 * never sees them. The `assistant` member (and so its package) cannot be
 * denied: that throws instead of silently keeping it, and its actions are
 * narrowed with `ELIZA_ACTION_ALLOWLIST`.
 *
 * The chat-authority settings these plugins answer under
 * (`ELIZA_CONVERSATION_CALLER_ROLE`, `ELIZA_ACTION_ALLOWLIST`) are validated
 * here too, before a runtime exists, so a malformed value fails the boot
 * rather than the first turn.
 */
export function createAssistantPlugins(
  character: Character,
  config: Pick<ElizaConfig, "plugins">,
  env: NodeJS.ProcessEnv = process.env,
): Plugin[] {
  resolveOwnerChatCallerRole(env);
  readActionAllowlist(env);
  const denied = collectConfiguredDeniedPluginNames(config, env);
  if (denied.has(ASSISTANT_PACKAGE_NAME) || denied.has(ASSISTANT_PLUGIN_NAME)) {
    throw new ElizaError(
      `Plugin ${ASSISTANT_PACKAGE_NAME} installs the message service and cannot be denied; deny its other members by plugin name and narrow its actions with ELIZA_ACTION_ALLOWLIST`,
      {
        code: "PLUGIN_DENY_UNENFORCEABLE",
        context: { pluginName: ASSISTANT_PACKAGE_NAME },
      },
    );
  }
  const settings = character.settings ?? {};
  const plugins: Plugin[] = [
    createAssistantPlugin(),
    {
      name: "connector-accounts",
      description: "Canonical connector account registry and storage",
      services: [ConnectorAccountManager],
    },
    identityHttpPlugin,
    documentsPlugin,
    trajectoriesPlugin,
    {
      name: "relationships-services",
      description: "Relationship storage and follow-ups",
      services: relationshipsPlugin.services,
    },
    {
      name: "credentials-setup",
      description: "Credential setup and activation",
      ...secretsCapability,
    },
    ...(enabled(settings.ENABLE_AUTONOMY)
      ? [
          {
            name: "autonomy",
            description: "Autonomous assistant tasks",
            ...autonomyCapabilities,
          },
        ]
      : []),
    ...(enabled(settings.ENABLE_TRUST)
      ? [
          {
            name: "trust",
            description: "Trust assessment",
            ...trustCapability,
            init: async (_config, runtime) => trustCapability.init(runtime),
          } satisfies Plugin,
        ]
      : []),
    ...(character.advancedMemory ? [createAdvancedMemoryPlugin()] : []),
    ...(character.advancedPlanning ? [createAdvancedPlanningPlugin()] : []),
  ];
  return plugins
    .filter((plugin) => !denied.has(plugin.name))
    .map((plugin) => ({ ...plugin }));
}

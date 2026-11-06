/** The agent host's ordinary assistant composition. Core loads only supplied plugins. */
import {
  type Character,
  ConnectorAccountManager,
  ElizaError,
  type Plugin,
} from "@elizaos/core";
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

import { identityHttpPlugin } from "../api/identity-person-link-routes";

const enabled = (value: unknown) => value === true || value === "true";

const ASSISTANT_PACKAGE_NAME = "@elizaos/plugin-assistant";
/** The member that installs the message service; a runtime cannot reply without it. */
const ASSISTANT_PLUGIN_NAME = "assistant";

/**
 * The host-built assistant plugins, minus every member the host's plugin deny
 * set names. These are composed here rather than resolved from the plugin
 * list, so the resolver's deny step never sees them. The `assistant` member
 * (and so its package) cannot be denied: that throws instead of silently
 * keeping it, and its actions are narrowed with `ELIZA_ACTION_ALLOWLIST`.
 */
export function createAssistantPlugins(
  character: Character,
  denied: ReadonlySet<string> = new Set(),
): Plugin[] {
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

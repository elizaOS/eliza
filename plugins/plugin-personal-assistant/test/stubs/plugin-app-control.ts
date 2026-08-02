/**
 * Test stand-in for the `@elizaos/plugin-app-control` barrel. The real barrel
 * drags the full app-control graph (views client, evaluators, providers) into
 * the LifeOps test bundle, so this stub keeps the plugin surface empty while
 * re-exporting the REAL settings action factory + parser from the source
 * subpath (aliased to `plugins/plugin-app-control/src` in vitest.config.ts) —
 * the agent's SETTINGS action (#14804) needs the genuine implementations.
 */
import type { Plugin } from "@elizaos/core";

export {
  createSettingsAction,
  parseSettingsRequest,
} from "@elizaos/plugin-app-control/actions/settings";

export const appControlPlugin: Plugin = {
  name: "plugin-app-control-test-stub",
  description: "Test stub for @elizaos/plugin-app-control",
  actions: [],
  providers: [],
  evaluators: [],
  services: [],
};

export default appControlPlugin;

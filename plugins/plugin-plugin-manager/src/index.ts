import type { Plugin } from "@elizaos/core";
import { pluginAction } from "./actions/plugin";
import { pluginConfigurationStatusProvider } from "./providers/pluginConfigurationStatus";
import { pluginStateProvider } from "./providers/pluginStateProvider";
import { registryPluginsProvider } from "./providers/registryPluginsProvider";
import { CoreManagerService } from "./services/coreManagerService";
import { PluginManagerService } from "./services/pluginManagerService";
import * as pluginRegistry from "./services/pluginRegistryService";
import * as types from "./types";

export { createPluginAction, pluginAction } from "./actions/plugin";
export { CoreManagerService, PluginManagerService, pluginRegistry, types };

export const pluginManagerPlugin: Plugin = {
  name: "plugin-manager",
  description: "Plugin discovery, install, eject/sync, registry search, and creation",
  actions: [pluginAction],
  providers: [pluginConfigurationStatusProvider, pluginStateProvider, registryPluginsProvider],
  // Evaluators not implemented yet
  evaluators: [],
  services: [PluginManagerService, CoreManagerService],
};

export default pluginManagerPlugin;

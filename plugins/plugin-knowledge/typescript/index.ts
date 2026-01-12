import type { Plugin } from "@elizaos/core";
import { knowledgeActions } from "./actions";
import { documentsProvider } from "./documents-provider";
import { knowledgeProvider } from "./provider";
import { knowledgeRoutes } from "./routes";
import { KnowledgeService } from "./service";

export interface KnowledgePluginConfig {
  enableUI?: boolean;
  enableRoutes?: boolean;
  enableActions?: boolean;
  enableTests?: boolean;
}

export function createKnowledgePlugin(config: KnowledgePluginConfig = {}): Plugin {
  const { enableUI = true, enableRoutes = true, enableActions = true, enableTests = true } = config;

  const plugin: Plugin = {
    name: "knowledge",
    description:
      "Plugin for Retrieval Augmented Generation, including knowledge management and embedding.",
    services: [KnowledgeService],
    providers: [knowledgeProvider, documentsProvider],
  };

  if (enableUI || enableRoutes) {
    plugin.routes = knowledgeRoutes;
  }

  if (enableActions) {
    plugin.actions = knowledgeActions;
  }

  if (enableTests) {
    try {
      const { default: knowledgeTestSuite } = require("./tests");
      plugin.tests = [knowledgeTestSuite];
    } catch {}
  }

  return plugin;
}

export const knowledgePluginCore: Plugin = createKnowledgePlugin({
  enableUI: false,
  enableRoutes: false,
  enableActions: false,
  enableTests: false,
});

export const knowledgePluginHeadless: Plugin = createKnowledgePlugin({
  enableUI: false,
  enableRoutes: false,
  enableActions: true,
  enableTests: false,
});

export const knowledgePlugin: Plugin = createKnowledgePlugin({
  enableUI: true,
  enableRoutes: true,
  enableActions: true,
  enableTests: true,
});

export default knowledgePlugin;

export { documentsProvider } from "./documents-provider";
export { knowledgeProvider } from "./provider";
export { KnowledgeService } from "./service";
export * from "./types";

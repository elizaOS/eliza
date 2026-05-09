import { registerAppRoutePluginLoader } from "@elizaos/core";

registerAppRoutePluginLoader(
  "@elizaos/plugin-n8n-workflow:routes",
  async () => {
    const { n8nWorkflowRoutePlugin } = await import("./plugin-routes");
    return n8nWorkflowRoutePlugin;
  },
);

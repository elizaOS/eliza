async function registerBrowserRoutePluginLoader(): Promise<void> {
  try {
    const { registerAppRoutePluginLoader } = await import(
      "@elizaos/app-core/runtime/app-route-plugin-registry"
    );
    registerAppRoutePluginLoader("@elizaos/app-browser", async () => {
      const { browserWorkspaceRoutePlugin } = await import("./setup-routes.js");
      return browserWorkspaceRoutePlugin;
    });
  } catch {
    // Older app-core package metadata does not expose the route-plugin registry.
    // In that case the main app-browser plugin still carries its rawPath routes.
  }
}

void registerBrowserRoutePluginLoader();

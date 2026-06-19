export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-lifeops-state") {
    return {
      viewType: "tui",
      plugin: "@elizaos/plugin-personal-assistant",
      enabled: true,
      request: typeof params?.request === "string" ? params.request : undefined,
      panels: ["brief", "approvals", "schedule"],
    };
  }

  if (capability === "terminal-lifeops-enable") {
    return {
      viewType: "tui",
      plugin: "@elizaos/plugin-personal-assistant",
      enabled: true,
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}

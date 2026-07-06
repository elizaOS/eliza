// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: ./optional-plugins.ts (OPTIONAL_STATIC_PLUGIN_PACKAGES).
// Regenerate: bun run --cwd packages/agent gen:optional-plugin-imports
//
// Literal `import()` specifiers so Bun.build inlines each optional plugin into
// the mobile bundle. The runtime looks each up by name in loadOptionalPlugin().

export const OPTIONAL_PLUGIN_IMPORTERS: Record<string, () => Promise<unknown>> =
  {
    "@elizaos/plugin-agent-orchestrator": () =>
      import("@elizaos/plugin-agent-orchestrator"),
    "@elizaos/plugin-task-coordinator": () =>
      import("@elizaos/plugin-task-coordinator"),
    "@elizaos/plugin-shell": () => import("@elizaos/plugin-shell"),
    "@elizaos/plugin-coding-tools": () =>
      import("@elizaos/plugin-coding-tools"),
    "@elizaos/plugin-pty": () => import("@elizaos/plugin-pty"),
    "@elizaos/plugin-birdclaw": () => import("@elizaos/plugin-birdclaw"),
    "@elizaos/plugin-ollama": () => import("@elizaos/plugin-ollama"),
    "@elizaos/plugin-elizacloud": () => import("@elizaos/plugin-elizacloud"),
    "@elizaos/plugin-commands": () => import("@elizaos/plugin-commands"),
    "@elizaos/plugin-video": () => import("@elizaos/plugin-video"),
    "@elizaos/plugin-vision": () => import("@elizaos/plugin-vision"),
    "@elizaos/plugin-background-runner": () =>
      import("@elizaos/plugin-background-runner"),
    "@elizaos/plugin-native-filesystem": () =>
      import("@elizaos/plugin-native-filesystem"),
    "@elizaos/plugin-scheduling": () => import("@elizaos/plugin-scheduling"),
    // biome-ignore lint/suspicious/noTsIgnore: mixed package tsconfigs make @ts-expect-error unstable here.
    // @ts-ignore: runtime subpath export is intentional; not every package tsconfig resolves its declaration condition.
    "@elizaos/plugin-inbox": () => import("@elizaos/plugin-inbox/plugin"),
    "@elizaos/plugin-app-control": () => import("@elizaos/plugin-app-control"),
    "@elizaos/plugin-anthropic": () => import("@elizaos/plugin-anthropic"),
    "@elizaos/plugin-openai": () => import("@elizaos/plugin-openai"),
  };

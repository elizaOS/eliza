/**
 * Generated literal import map that lets Bun inline optional mobile plugins.
 * The source of truth is OPTIONAL_STATIC_PLUGIN_PACKAGES in optional-plugins.ts;
 * regenerate with `bun run --cwd packages/agent gen:optional-plugin-imports`.
 * Do not edit this output by hand.
 */

export const OPTIONAL_PLUGIN_IMPORTERS: Record<string, () => Promise<unknown>> =
  {
    "@elizaos/plugin-agent-orchestrator": () =>
      import("@elizaos/plugin-agent-orchestrator"),
    "@elizaos/plugin-task-coordinator": () =>
      import("@elizaos/plugin-task-coordinator"),
    "@elizaos/plugin-coding-tools": () =>
      import("@elizaos/plugin-coding-tools"),
    "@elizaos/plugin-pty": () => import("@elizaos/plugin-pty"),
    "@elizaos/plugin-elizacloud": () => import("@elizaos/plugin-elizacloud"),
    "@elizaos/plugin-commands": () => import("@elizaos/plugin-commands"),
    "@elizaos/plugin-video": () => import("@elizaos/plugin-video"),
    "@elizaos/plugin-vision": () => import("@elizaos/plugin-vision"),
    "@elizaos/plugin-native-filesystem": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: optional mobile bundle plugin is outside sibling typecheck build graph; runtime import is guarded.
      import("@elizaos/plugin-native-filesystem"),
    "@elizaos/plugin-inbox": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: runtime subpath export is intentional; not every package tsconfig resolves its declaration condition.
      import("@elizaos/plugin-inbox/plugin"),
    "@elizaos/plugin-app-control": () => import("@elizaos/plugin-app-control"),
    "@elizaos/plugin-notes": () => import("@elizaos/plugin-notes/plugin"),
    "@elizaos/plugin-todos": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: todos is peer-linked to avoid the todos -> agent runtime dependency cycle; the deferred import runs after agent module initialization.
      import("@elizaos/plugin-todos/plugin"),
    "@elizaos/plugin-documents": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: documents is peer-linked to avoid the documents -> agent runtime dependency cycle; the deferred import runs after agent module initialization.
      import("@elizaos/plugin-documents/plugin"),
    "@elizaos/plugin-calendar": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: calendar is peer-linked to avoid the calendar -> agent runtime dependency cycle; the deferred import runs after agent module initialization.
      import("@elizaos/plugin-calendar/plugin"),
    "@elizaos/plugin-anthropic": () => import("@elizaos/plugin-anthropic"),
    "@elizaos/plugin-openai": () => import("@elizaos/plugin-openai"),
  };

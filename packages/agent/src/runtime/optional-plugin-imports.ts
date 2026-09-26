/**
 * Authored literal imports let the host bundler include optional plugins without
 * executing them at module initialization. Registration keys derive from this map.
 * Deferred loading keeps optional plugin initialization under host control.
 */

export const OPTIONAL_PLUGIN_IMPORTERS: Record<string, () => Promise<unknown>> =
  {
    "@elizaos/plugin-agent-orchestrator": () =>
      import("@elizaos/plugin-agent-orchestrator"),
    "@elizaos/plugin-agent-orchestrator/ui": () =>
      import("@elizaos/plugin-agent-orchestrator/ui"),
    "@elizaos/plugin-coding-tools": () =>
      import("@elizaos/plugin-coding-tools"),
    "@elizaos/plugin-pty": () => import("@elizaos/plugin-pty"),
    "@elizaos/plugin-elizacloud": () => import("@elizaos/plugin-elizacloud"),
    "@elizaos/plugin-video": () => import("@elizaos/plugin-video"),
    "@elizaos/plugin-vision": () => import("@elizaos/plugin-vision"),
    "@elizaos/plugin-native-filesystem": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: optional mobile bundle plugin is outside sibling typecheck build graph; runtime import is guarded.
      import("@elizaos/plugin-native-filesystem"),
    "@elizaos/plugin-inbox": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: not every sibling package resolves optional plugin declarations before they are built.
      import("@elizaos/plugin-inbox"),
    "@elizaos/plugin-notes": () => import("@elizaos/plugin-notes"),
    "@elizaos/plugin-todos": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: todos is peer-linked to avoid the todos -> agent runtime dependency cycle; the deferred import runs after agent module initialization.
      import("@elizaos/plugin-todos"),
    "@elizaos/plugin-knowledge": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: documents is peer-linked to avoid the documents -> agent runtime dependency cycle; the deferred import runs after agent module initialization.
      import("@elizaos/plugin-knowledge"),
    "@elizaos/plugin-calendar": () =>
      // biome-ignore lint/suspicious/noTsIgnore: optional literal imports may be unbuilt in sibling source typechecks.
      // @ts-ignore: calendar is peer-linked to avoid the calendar -> agent runtime dependency cycle; the deferred import runs after agent module initialization.
      import("@elizaos/plugin-calendar"),
    "@elizaos/plugin-anthropic": () => import("@elizaos/plugin-anthropic"),
    "@elizaos/plugin-openai": () => import("@elizaos/plugin-openai"),
  };

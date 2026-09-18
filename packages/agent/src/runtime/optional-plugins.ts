/** Optional registration metadata. Literal imports are authored once in the import map. */
import { OPTIONAL_PLUGIN_IMPORTERS } from "./optional-plugin-imports.ts";

export const OPTIONAL_STATIC_PLUGIN_PACKAGES: readonly string[] = Object.keys(
  OPTIONAL_PLUGIN_IMPORTERS,
);

/**
 * Optional plugins the runtime can load by name but that are intentionally NOT
 * baked into the mobile bundle as literal imports — they load through a bare
 * dynamic `import(packageName)` from a node_modules/desktop install instead.
 *
 * `@elizaos/plugin-gitpathologist` is a desktop-only git-forensics dev tool
 * (skipped up front on android/ios in the descriptor table); baking it into the
 * mobile bundle would pull its dependency tree in for a surface phones never use.
 */
export const UNBUNDLED_OPTIONAL_PLUGINS: readonly string[] = [
  "@elizaos/plugin-gitpathologist",
  "@elizaos/plugin-zerollama",
  // ESP32 companion device bridge (#18957): opt-in, desktop/node only — the
  // device is LAN hardware a phone-resident agent never drives, so it stays
  // out of the mobile bundle.
  "@elizaos/plugin-companion",
];

/** Deferred registrations preserve bundled-first order; each package is authored once. */
export const OPTIONAL_STATIC_PLUGIN_REGISTRATIONS: readonly string[] = [
  ...OPTIONAL_STATIC_PLUGIN_PACKAGES,
  ...UNBUNDLED_OPTIONAL_PLUGINS,
];

/**
 * Per-plugin descriptor overrides for the optional static registrations above.
 * Everything not listed here uses the defaults (registryName = packageName,
 * bundled = literal import, no platform skip). Keeping the overrides declared
 * beside the list they annotate means the `eliza.ts` descriptor builder stays a
 * pure map over {@link OPTIONAL_STATIC_PLUGIN_REGISTRATIONS} with no per-plugin
 * special-casing baked into the runtime module.
 */
export interface OptionalStaticPluginOverride {
  /**
   * Registry key the module is stored under in `STATIC_ELIZA_PLUGINS` when it
   * differs from the package name (short-name resolution, e.g. the
   * orchestrator resolves as `"agent-orchestrator"`).
   */
  readonly registryName?: string;
  /**
   * When true, skip the import up front on android/ios instead of paying the
   * full deferred-plugin boot timeout before it is dropped (desktop-only tools
   * absent from the mobile bundle).
   */
  readonly skipOnMobile?: boolean;
  /**
   * Package-exports subpath holding the runtime `Plugin` half when the root
   * barrel is not it (runtime-app plugins whose root export pulls React view
   * components — see RUNTIME_APP_PLUGIN_SUBPATHS in plugin-resolver.ts). The
   * authored literal import and every dynamic fallback use this subpath; the
   * registry key stays the bare package name.
   */
  readonly importSubpath?: "./plugin";
}

/**
 * Whether this process explicitly requested the workspace-source export
 * condition. Bun exposes command-line conditions through `process.execArgv`,
 * including when the entry process was launched with `--no-install`.
 */
export function hasElizaSourceRuntimeCondition(
  execArgv: readonly string[] = process.execArgv,
): boolean {
  for (let index = 0; index < execArgv.length; index += 1) {
    const argument = execArgv[index];
    if (argument === "--conditions=eliza-source") return true;
    if (argument === "--conditions" && execArgv[index + 1] === "eliza-source") {
      return true;
    }
  }
  return false;
}

export const OPTIONAL_STATIC_PLUGIN_OVERRIDES: Readonly<
  Record<string, OptionalStaticPluginOverride>
> = {
  "@elizaos/plugin-agent-orchestrator": { registryName: "agent-orchestrator" },
  // Not in the mobile bundle — attempting the import there hangs the full
  // deferred-plugin timeout before being skipped. Skip it up front on
  // android/ios (it is a desktop dev tool, already gated in plugin-collector).
  "@elizaos/plugin-gitpathologist": { skipOnMobile: true },
  // Ollama is a desktop/server HTTP daemon; never spend a mobile boot timeout
  // trying to import a provider that cannot run on the phone itself.
  "@elizaos/plugin-zerollama": { skipOnMobile: true },
  // The ESP32 companion bridge is desktop-only opt-in hardware tooling; it is
  // absent from the mobile bundle, so skip the import up front on android/ios.
  "@elizaos/plugin-companion": { skipOnMobile: true },
  // Root barrel exports the InboxView React components; the runtime plugin
  // object lives at the ./plugin subpath (src/plugin.ts). Bundling the root
  // would drag react/.tsx into the bun-target mobile agent bundle. (In
  // packages/agent's package.json this is an optional PEER dependency, not a
  // regular one: plugin-inbox depends on app-core which depends on agent, so
  // a regular dep closes a turbo build cycle; peers stay out of the task
  // graph while bun still links the workspace package for resolution.)
  "@elizaos/plugin-inbox": {
    importSubpath: "./plugin",
  },
  "@elizaos/plugin-notes": {
    importSubpath: "./plugin",
  },
  "@elizaos/plugin-todos": {
    importSubpath: "./plugin",
  },
  "@elizaos/plugin-documents": {
    importSubpath: "./plugin",
  },
  "@elizaos/plugin-calendar": {
    importSubpath: "./plugin",
  },
};

/**
 * Import specifier for a package's runtime plugin module — the bare package
 * name unless an `importSubpath` override points at a dedicated runtime entry.
 * Used by the runtime dynamic-import fallback; the import-map contract test
 * checks that literal imports use the same runtime entry.
 */
export function optionalPluginImportSpecifier(packageName: string): string {
  const subpath = OPTIONAL_STATIC_PLUGIN_OVERRIDES[packageName]?.importSubpath;
  return subpath ? `${packageName}${subpath.slice(1)}` : packageName;
}

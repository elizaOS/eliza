/**
 * Source of truth for the optional plugins that must be baked into the mobile
 * bundle via **literal** `import()` calls.
 *
 * `Bun.build` can only inline a dynamic import whose specifier is a string
 * literal. The runtime resolves optional plugins by name (a variable), so a
 * hand-written `if (name === X) import(X)` chain used to exist purely to hand
 * the bundler those literals. That chain silently drifted from the descriptor
 * table in `eliza.ts`: a plugin added to the table without a matching branch
 * became non-bundleable with no error.
 *
 * Instead, this module owns the list, `optional-plugin-imports.generated.ts` is
 * code-generated from it (literal imports the bundler sees), and
 * `optional-plugins.test.ts` fails if the generated file drifts or if a
 * descriptor-table entry has no importer. Regenerate with:
 *
 *   bun run --cwd packages/agent gen:optional-plugin-imports
 *
 * @module optional-plugins
 */

/**
 * Optional plugin packages baked into the bundle via literal imports. Order is
 * preserved into the generated file for a stable diff. Adding an entry here (and
 * regenerating) is the ONLY step needed to make a new optional plugin
 * bundleable — never hand-write an import branch.
 */
export const OPTIONAL_STATIC_PLUGIN_PACKAGES: readonly string[] = [
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-task-coordinator",
  "@elizaos/plugin-shell",
  "@elizaos/plugin-coding-tools",
  // Opt-in only: dormant unless a character lists @elizaos/plugin-pty (no
  // autoEnable). Registers PTY_SERVICE so the web terminal can drive a real
  // interactive CLI (eliza-code on Eliza Cloud/cerebras).
  "@elizaos/plugin-pty",
  // Auto-on only when the host has the birdclaw CLI or an existing ~/.birdclaw
  // data root (see birdclawRequested in plugin-collector.ts). Registers
  // BIRDCLAW_SERVICE + the local Twitter/X archive view/action.
  "@elizaos/plugin-birdclaw",
  "@elizaos/plugin-ollama",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-commands",
  "@elizaos/plugin-video",
  // MOBILE_CORE_PLUGINS lists plugin-vision (screen understanding on mobile —
  // GET_SCREEN, the renderer-pulled screen-capture bridge, and the #11111 ML
  // Kit OCR bridge routes), but without a static registration the mobile agent
  // bundle could never resolve it: the renderer OCR poller polled
  // /api/vision/ocr-requests into a 404 forever (verified on emulator-5554).
  "@elizaos/plugin-vision",
  "@elizaos/plugin-background-runner",
  // The remaining MOBILE_CORE_PLUGINS + MOBILE_VIEW_PLUGINS entries. The mobile
  // resolver can only load @elizaos plugins that are pre-registered in
  // STATIC_ELIZA_PLUGINS (no node_modules tree ships in the APK), so every
  // plugin the mobile allow-list keeps MUST have a literal importer here —
  // without one it is silently dropped at boot: no ScheduledTask runner, no
  // FILE target=device, no VIEWS chat navigation, a dead inbox tile, and
  // health still reporting failed:0. The bundle-loadability drift guard in
  // core-plugins-profile-metadata.test.ts pins this invariant.
  "@elizaos/plugin-native-filesystem",
  "@elizaos/plugin-scheduling",
  "@elizaos/plugin-inbox",
  "@elizaos/plugin-app-control",
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-openai",
];

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
];

/**
 * The single ordered source of truth for the optional (deferred-phase) static
 * plugin registrations the runtime installs at boot. Both the bundle-manifest
 * layer (`OPTIONAL_STATIC_PLUGIN_PACKAGES`, which decides mobile-bundleability)
 * and the runtime descriptor table (`CORE_STATIC_PLUGIN_REGISTRATIONS` in
 * `eliza.ts`, which decides what actually registers into `STATIC_ELIZA_PLUGINS`)
 * MUST derive their optional-plugin set from this list — they used to be two
 * hand-mirrored parallel lists that silently drifted (a plugin added to one but
 * not the other became either non-bundleable or bundled-but-never-registered).
 *
 * Order is bundled-first then unbundled; the deferred boot phase iterates this
 * order, but registration only populates the name-keyed `STATIC_ELIZA_PLUGINS`
 * map (capability winners are decided later by the model router / plugin
 * resolver, not by this order), so order is a stable-diff / log-sequence
 * concern, not a behavioral one.
 */
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
   * generated literal import and every dynamic fallback use this subpath; the
   * registry key stays the bare package name.
   */
  readonly importSubpath?: "./plugin";
}

export const OPTIONAL_STATIC_PLUGIN_OVERRIDES: Readonly<
  Record<string, OptionalStaticPluginOverride>
> = {
  "@elizaos/plugin-agent-orchestrator": { registryName: "agent-orchestrator" },
  // Not in the mobile bundle — attempting the import there hangs the full
  // deferred-plugin timeout before being skipped. Skip it up front on
  // android/ios (it is a desktop dev tool, already gated in plugin-collector).
  "@elizaos/plugin-gitpathologist": { skipOnMobile: true },
  // Root barrel exports the InboxView React components; the runtime plugin
  // object lives at the ./plugin subpath (src/plugin.ts). Bundling the root
  // would drag react/.tsx into the bun-target mobile agent bundle. (In
  // packages/agent's package.json this is an optional PEER dependency, not a
  // regular one: plugin-inbox depends on app-core which depends on agent, so
  // a regular dep closes a turbo build cycle; peers stay out of the task
  // graph while bun still links the workspace package for resolution.)
  "@elizaos/plugin-inbox": { importSubpath: "./plugin" },
};

/**
 * Import specifier for a package's runtime plugin module — the bare package
 * name unless an `importSubpath` override points at a dedicated runtime entry.
 * Single definition shared by the codegen renderer, the runtime dynamic-import
 * fallback, and the drift test so all three resolve the same module.
 */
export function optionalPluginImportSpecifier(packageName: string): string {
  const subpath = OPTIONAL_STATIC_PLUGIN_OVERRIDES[packageName]?.importSubpath;
  return subpath ? `${packageName}${subpath.slice(1)}` : packageName;
}

const RELATIVE_GENERATED_PATH = "./optional-plugin-imports.generated.ts";

/**
 * Render the generated importer module from a package list. Pure so the codegen
 * script and the drift test share one definition.
 */
export function renderOptionalPluginImportsModule(
  packages: readonly string[],
): string {
  const entries = packages
    .map((pkg) => {
      const specifier = optionalPluginImportSpecifier(pkg);
      return `  "${pkg}": () => import("${specifier}"),`;
    })
    .join("\n");
  return `// GENERATED FILE — DO NOT EDIT BY HAND.
// Source of truth: ./optional-plugins.ts (OPTIONAL_STATIC_PLUGIN_PACKAGES).
// Regenerate: bun run --cwd packages/agent gen:optional-plugin-imports
//
// Literal \`import()\` specifiers so Bun.build inlines each optional plugin into
// the mobile bundle. The runtime looks each up by name in loadOptionalPlugin().

export const OPTIONAL_PLUGIN_IMPORTERS: Record<
  string,
  () => Promise<unknown>
> = {
${entries}
};
`;
}

export { RELATIVE_GENERATED_PATH };

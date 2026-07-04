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
  "@elizaos/plugin-pty",
  "@elizaos/plugin-birdclaw",
  "@elizaos/plugin-ollama",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-commands",
  "@elizaos/plugin-video",
  "@elizaos/plugin-vision",
  "@elizaos/plugin-background-runner",
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

const RELATIVE_GENERATED_PATH = "./optional-plugin-imports.generated.ts";

/**
 * Render the generated importer module from a package list. Pure so the codegen
 * script and the drift test share one definition.
 */
export function renderOptionalPluginImportsModule(
  packages: readonly string[],
): string {
  const entries = packages
    .map((pkg) => `  "${pkg}": () => import("${pkg}"),`)
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

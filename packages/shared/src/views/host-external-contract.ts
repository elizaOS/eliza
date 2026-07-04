/**
 * Contract for the host-external view-bundle factory shared by the agent server
 * and the UI shell. A plugin view bundle is built with framework/host packages
 * (`@elizaos/ui`, `react`, three, …) left as external bare imports; those must
 * resolve to the host shell's live singletons, not to a second copy. The agent
 * bundle route serves each view wrapped as a factory (see
 * `packages/agent/src/api/dynamic-view-host-external.mjs`) whose default export
 * matches {@link HostExternalBundleFactory}: it takes a {@link HostModuleImporter}
 * and returns the view's export namespace. The shell's `DynamicViewLoader`
 * imports the wrapped module and calls the factory with an importer backed by
 * its host-external map — sharing the host realm with no `globalThis` bridge.
 *
 * This is the typed contract only; the runtime transform is the `.mjs` above
 * (kept dependency-free so the node-run Playwright smoke stub can import it by
 * path without a build).
 */

/**
 * Resolve a host-external module specifier to the host shell's live module
 * namespace (e.g. the singleton `react`, `@elizaos/ui`). Rejects when the
 * specifier is neither a framework trunk external nor a registered one.
 */
export type HostModuleImporter = (
  specifier: string,
) => Promise<Record<string, unknown>>;

/**
 * The default export of a served view bundle. Called once by the loader with a
 * {@link HostModuleImporter}; resolves to the bundle's export namespace (the
 * view component plus any `interact` / `cleanup` exports).
 */
export type HostExternalBundleFactory = (
  hostImport: HostModuleImporter,
) => Promise<Record<string, unknown>>;

/** URL query flag the loader sets to request the host-external factory serve. */
export const HOST_EXTERNAL_RUNTIME_PARAM = "hostExternalRuntime";

/** URL query key carrying the comma-joined host-external specifier list. */
export const HOST_EXTERNAL_SPECIFIERS_PARAM = "hostExternalSpecifiers";

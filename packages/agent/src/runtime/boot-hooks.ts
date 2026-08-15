/**
 * Registry-driven pre-ready boot hooks shared by every agent host. The registry
 * declares optional hook modules; this module resolves and invokes them without
 * coupling startup to any specific plugin.
 *
 * Two absences are designed rather than exceptional, and both are load-bearing
 * for voice. A packaged bundle that does not stage `generated.json` makes
 * `loadRegistry()` return an empty set on purpose
 * (`packages/registry/src/first-party/index.ts` marks that `error-policy:J4`), so
 * the registry alone cannot be the only source of the local-inference hook —
 * nothing else installs the local TEXT/EMBEDDING/TRANSCRIPTION/TTS handlers, and
 * without them voice reports not-ready with no failure at the boot site. And a
 * host may legitimately ship without the optional plugin at all, which must skip
 * rather than abort startup.
 */

import { type AgentRuntime, logger } from "@elizaos/core";
import {
  getApps,
  getPlugins,
  loadRegistry,
} from "@elizaos/registry/first-party";

export interface BootHookDeclaration {
  id: string;
  specifier: string;
  exportName: string;
}

export interface BootHookContributor {
  id: string;
  invoke: (runtime: AgentRuntime) => Promise<void>;
}

type BootHookModule = Record<string, unknown>;
type BootHook = (runtime: AgentRuntime) => void | Promise<void>;

/**
 * Literal importers for host-owned hooks that must survive mobile bundling.
 * Registry hooks remain extensible through the dynamic-import fallback below,
 * but a computed specifier is invisible to Bun and cannot be the only import
 * path for code embedded in an APK without a node_modules tree.
 */
const BUNDLED_BOOT_HOOK_IMPORTERS: Readonly<
  Record<string, () => Promise<BootHookModule>>
> = {
  "@elizaos/plugin-local-inference/runtime": () =>
    import(
      "@elizaos/plugin-local-inference/runtime"
    ) as Promise<BootHookModule>,
};

/**
 * Host-owned declarations appended when the registry does not supply one for the
 * same id. These are not a duplicate source of truth: a registry declaration
 * always wins, and this only covers the packaged-build case where the registry
 * is empty by design.
 */
const FALLBACK_BOOT_HOOK_DECLARATIONS: readonly BootHookDeclaration[] = [
  {
    id: "@elizaos/plugin-local-inference",
    specifier: "@elizaos/plugin-local-inference/runtime",
    exportName: "registerLocalInferenceBoot",
  },
];

/**
 * True only when `specifier` itself could not be resolved — not when the hook
 * module loaded and one of *its* imports was missing. Skipping on the latter
 * would turn a genuinely broken plugin into a silent no-op.
 */
function isMissingModule(error: unknown, specifier: string): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND") {
    return false;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes(specifier);
}

async function loadAndInvokeBootHook(
  declaration: BootHookDeclaration,
  runtime: AgentRuntime,
): Promise<void> {
  let module: BootHookModule;
  try {
    const bundledImporter = BUNDLED_BOOT_HOOK_IMPORTERS[declaration.specifier];
    module = bundledImporter
      ? await bundledImporter()
      : ((await import(
          /* webpackIgnore: true */ declaration.specifier
        )) as BootHookModule);
  } catch (error) {
    // error-policy:J4 a host that ships without an optional hook module is a
    // supported deployment, so its absence degrades to "no hook". Anything else,
    // including a broken import inside the hook module, still fails the boot.
    if (isMissingModule(error, declaration.specifier)) {
      logger.debug(
        `[eliza] boot hook ${declaration.id} not installed (${declaration.specifier}); skipping`,
      );
      return;
    }
    throw error;
  }
  const hook = module[declaration.exportName];
  if (typeof hook !== "function") {
    throw new Error(
      `[eliza] ${declaration.specifier} did not export boot-hook function "${declaration.exportName}"`,
    );
  }
  await (hook as BootHook)(runtime);
}

/** Resolve narrow registry declarations into executable contributors. */
export function resolveBootHookContributors(
  declarations: BootHookDeclaration[],
): BootHookContributor[] {
  const contributors = new Map<string, BootHookContributor>();
  for (const declaration of [
    ...declarations,
    ...FALLBACK_BOOT_HOOK_DECLARATIONS,
  ]) {
    if (contributors.has(declaration.id)) continue;
    contributors.set(declaration.id, {
      id: declaration.id,
      invoke: (runtime) => loadAndInvokeBootHook(declaration, runtime),
    });
  }
  return [...contributors.values()];
}

/** Read every app and plugin boot-hook declaration from the first-party registry. */
export function getBootHookContributors(): BootHookContributor[] {
  const registry = loadRegistry();
  const declarations: BootHookDeclaration[] = [];
  for (const entry of [...getApps(registry), ...getPlugins(registry)]) {
    const bootHook = entry.launch?.bootHook;
    if (!bootHook) continue;
    declarations.push({
      id: entry.npmName ?? entry.id,
      specifier: bootHook.specifier,
      exportName: bootHook.exportName,
    });
  }
  return resolveBootHookContributors(declarations);
}

/** Invoke contributors in registry order and fail startup on a broken declaration. */
export async function drainBootHookContributors(
  runtime: AgentRuntime,
  contributors: BootHookContributor[],
): Promise<void> {
  for (const contributor of contributors) {
    await contributor.invoke(runtime);
  }
}

/** Run the registry-declared pre-ready hook channel exactly once per boot. */
export async function runBootHooks(runtime: AgentRuntime): Promise<void> {
  await drainBootHookContributors(runtime, getBootHookContributors());
}

/**
 * Registry-driven pre-ready boot hooks shared by every agent host. The registry
 * declares optional hook modules; this module resolves and invokes them without
 * coupling startup to any specific plugin.
 */

import type { AgentRuntime } from "@elizaos/core";
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

async function loadAndInvokeBootHook(
  declaration: BootHookDeclaration,
  runtime: AgentRuntime,
): Promise<void> {
  const module = (await import(
    /* webpackIgnore: true */ declaration.specifier
  )) as BootHookModule;
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
  for (const declaration of declarations) {
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

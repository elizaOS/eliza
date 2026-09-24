/** Rejects backend runtime dependencies; explicit core protocol leaves remain ordinary browser modules. */
import { builtinModules } from "node:module";
import type { Plugin } from "vite";

const nodeModules = new Set(builtinModules.flatMap((id) => [id, `node:${id}`]));

function isCoreRuntime(id: string): boolean {
  return (
    nodeModules.has(id) ||
    id.startsWith("node:") ||
    id === "@elizaos/core" ||
    id === "@elizaos/core/index" ||
    id === "@elizaos/agent" ||
    id.startsWith("@elizaos/agent/")
  );
}

export function rejectRuntimeInRendererPlugin(): Plugin {
  let serving = false;
  const importers = new Map<string, Set<string>>();
  return {
    name: "reject-runtime-in-renderer",
    enforce: "pre",
    configResolved(config) {
      serving = config.command === "serve";
    },
    resolveId(id, importer) {
      if (!isCoreRuntime(id)) return null;
      if (importer) {
        const origins = importers.get(id) ?? new Set<string>();
        origins.add(importer);
        importers.set(id, origins);
      }
      if (serving) {
        this.error(
          `Node runtime import ${id} reached renderer from ${importer ?? "entry"}.`,
        );
      }
      // Keep the dependency opaque until Rollup removes unused package exports.
      // Retained imports are rejected below; runtime code is never substituted.
      return { id, external: true };
    },
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const runtime = [...output.imports, ...output.dynamicImports].find(
          isCoreRuntime,
        );
        if (runtime) {
          const importers =
            this.getModuleInfo(runtime)?.importers.filter(
              (id) => id in output.modules,
            ) ?? [];
          this.error(
            `Node runtime import ${runtime} survived in renderer chunk ${output.fileName}. Importing modules: ${importers.join(", ") || "dynamic import"}.`,
          );
        }
      }
    },
  };
}

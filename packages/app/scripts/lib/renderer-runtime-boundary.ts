/** Rejects emitted runtime dependencies while allowing unused exports in shared package barrels. */
import type { Plugin } from "vite";

function isCoreRuntime(id: string): boolean {
  return id === "@elizaos/core" || id.startsWith("@elizaos/core/");
}

export function rejectRuntimeInRendererPlugin(): Plugin {
  let serving = false;
  return {
    name: "reject-runtime-in-renderer",
    enforce: "pre",
    configResolved(config) {
      serving = config.command === "serve";
    },
    resolveId(id, importer) {
      if (!isCoreRuntime(id)) return null;
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

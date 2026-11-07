/** Rejects backend runtime dependencies; explicit core protocol leaves remain ordinary browser modules. */
import { builtinModules } from "node:module";
import type { Plugin } from "vite";

const nodeModules = new Set(builtinModules.flatMap((id) => [id, `node:${id}`]));

const hostPackages = new Set([
  "node-llama-cpp",
  "fs-extra",
  "pty-state-capture",
  "pty-console",
  "pty-manager",
  "electron",
  "undici",
  "sharp",
  "puppeteer-core",
  "@puppeteer/browsers",
  "@elizaos/plugin-anthropic",
  "@elizaos/plugin-pdf",
  "@elizaos/plugin-telegram",
  "@elizaos/plugin-edge-tts",
  "@node-rs/argon2",
  "@node-rs/argon2-wasm32-wasi",
  "drizzle-orm",
  "mammoth",
  "unpdf",
]);
const hostEntries = new Set([
  "@elizaos/auth/vault",
  "@elizaos/auth/accounts",
  "@elizaos/plugin-elizacloud",
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-local-inference",
  "@elizaos/plugin-local-inference/routes",
  "@elizaos/plugin-local-inference/runtime",
  "@elizaos/plugin-local-inference/services",
  "@elizaos/plugin-local-inference/runtime/embedding-presets",
]);

function isHostRuntime(id: string): boolean {
  const packageName = id.startsWith("@")
    ? id.split("/").slice(0, 2).join("/")
    : id.split("/")[0];
  return (
    hostPackages.has(packageName) ||
    hostEntries.has(id) ||
    /^@(?:node-llama-cpp\/|img\/sharp|napi-rs\/keyring)/.test(id) ||
    nodeModules.has(id) ||
    id.startsWith("node:") ||
    id === "@elizaos/app" ||
    id === "@elizaos/core" ||
    id === "@elizaos/host" ||
    id === "@elizaos/contracts/node" ||
    id === "@elizaos/core/index" ||
    id === "@elizaos/plugin-sql" ||
    id.startsWith("@elizaos/plugin-sql/") ||
    id === "@elizaos/agent" ||
    id.startsWith("@elizaos/agent/")
  );
}

export function rejectRuntimeInRendererPlugin(): Plugin {
  let serving = false;
  const importOrigins = new Map<string, Set<string>>();
  return {
    name: "reject-runtime-in-renderer",
    enforce: "pre",
    configResolved(config) {
      serving = config.command === "serve";
    },
    resolveId(id, importer) {
      if (!isHostRuntime(id)) return null;
      if (importer) {
        const origins = importOrigins.get(id) ?? new Set<string>();
        origins.add(importer);
        importOrigins.set(id, origins);
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
          isHostRuntime,
        );
        if (runtime) {
          const importers = [
            ...new Set([
              ...(importOrigins.get(runtime) ?? []),
              ...(this.getModuleInfo(runtime)?.importers.filter(
                (id) => id in output.modules,
              ) ?? []),
            ]),
          ];
          this.error(
            `Node runtime import ${runtime} survived in renderer chunk ${output.fileName}. Importing modules: ${importers.join(", ") || "dynamic import"}.`,
          );
        }
      }
    },
  };
}

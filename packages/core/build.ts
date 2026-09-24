/** Publish the Node runtime and explicitly exported leaf contracts as ESM modules. */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export async function buildCore(options: { watch?: boolean } = {}): Promise<void> {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const run = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Core build failed: ${command} (${result.status})`);
  };
  run("bun", ["x", "--no-install", "tsc6", "--noCheck", "-p", "tsconfig.emit.json", ...(options.watch ? ["--watch"] : [])]);
  run(process.execPath, ["../scripts/rewrite-dist-relative-imports-node-esm.mjs", "packages/core"]);
  run(process.execPath, ["../scripts/copy-package-assets.mjs", "packages/core", "src/catalog/generated.json", "src/catalog/curated-app-definitions.json", "src/catalog/channel-plugin-map.json", "src/catalog/provider-plugin-map.json", "src/catalog/short-id-plugin-map.json", "src/restart-exit-code.json"]);
}

if (import.meta.main) await buildCore({ watch: process.argv.includes("--watch") });

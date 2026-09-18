/** Node provider with a lightweight host endpoint configuration entry. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

export async function buildOpenAI(options: { watch?: boolean } = {}): Promise<void> {
  const root = fileURLToPath(new URL(".", import.meta.url));
  const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  await build({
    entry: { index: `${root}index.ts`, "endpoint-config": `${root}utils/config.ts` },
    outDir: `${root}dist`,
    tsconfig: `${root}tsconfig.build.json`,
    platform: "node",
    target: "node24",
    format: ["esm"],
    splitting: true,
    dts: true,
    // Calls from the workspace root must keep package dependencies external too.
    external: [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ],
    clean: true,
    sourcemap: false,
    watch: options.watch
      ? [`${root}index.ts`, `${root}models`, `${root}utils`, `${root}providers`, `${root}types`]
      : false,
  });
}

if (import.meta.main) await buildOpenAI({ watch: process.argv.includes("--watch") });

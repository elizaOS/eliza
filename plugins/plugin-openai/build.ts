/** Node provider with a lightweight host endpoint configuration entry. */
import { fileURLToPath } from "node:url";
import { build } from "tsup";

export async function buildOpenAI(options: { watch?: boolean } = {}): Promise<void> {
  const root = fileURLToPath(new URL(".", import.meta.url));
  await build({
    entry: { index: `${root}index.ts`, "endpoint-config": `${root}utils/config.ts` },
    outDir: `${root}dist`,
    tsconfig: `${root}tsconfig.build.json`,
    platform: "node",
    target: "node24",
    format: ["esm"],
    splitting: true,
    dts: true,
    clean: true,
    sourcemap: false,
    watch: options.watch
      ? [`${root}index.ts`, `${root}models`, `${root}utils`, `${root}providers`, `${root}types`]
      : false,
  });
}

if (import.meta.main) await buildOpenAI({ watch: process.argv.includes("--watch") });

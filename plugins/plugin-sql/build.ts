/** Node-only SQL adapter, with explicit schema and query-helper entry points. */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

export async function buildPluginSql(
  options: { watch?: boolean } = {},
): Promise<void> {
  const root = fileURLToPath(new URL(".", import.meta.url));
  await rm(`${root}src/dist`, { recursive: true, force: true });
  await build({
    entry: {
      index: `${root}src/index.ts`,
      schema: `${root}src/schema/index.ts`,
      drizzle: `${root}src/drizzle/index.ts`,
    },
    outDir: `${root}dist`,
    tsconfig: `${root}tsconfig.build.json`,
    platform: "node",
    target: "node24",
    format: ["esm"],
    splitting: true,
    dts: true,
    clean: true,
    sourcemap: false,
    watch: options.watch ? `${root}src` : false,
  });
}

if (import.meta.main)
  await buildPluginSql({ watch: process.argv.includes("--watch") });

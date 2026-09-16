/** Node-only distribution: one ESM barrel and one bundled declaration. */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

export async function buildCore(
	options: { watch?: boolean } = {},
): Promise<void> {
	const root = fileURLToPath(new URL(".", import.meta.url));
	await rm(`${root}dist`, { recursive: true, force: true });
	await build({
		entry: { index: `${root}src/index.ts` },
		outDir: `${root}dist`,
		tsconfig: `${root}tsconfig.build.json`,
		platform: "node",
		target: "node24",
		format: ["esm"],
		splitting: false,
		dts: true,
		noExternal: ["@elizaos/common"],
		clean: true,
		sourcemap: false,
		watch: options.watch ? `${root}src` : false,
	});
}

if (import.meta.main) {
	await buildCore({ watch: process.argv.includes("--watch") });
}

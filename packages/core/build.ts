/** Node-only distribution: one ESM barrel and one bundled declaration. */

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "tsup";

export async function buildCore(
	options: { watch?: boolean } = {},
): Promise<void> {
	const root = fileURLToPath(new URL(".", import.meta.url));
	const manifest = JSON.parse(
		readFileSync(new URL("./package.json", import.meta.url), "utf8"),
	);
	// Keep the last complete declarations available to concurrent consumers.
	// Watch mode owns its output continuously and must never clean it either.
	const output = options.watch
		? `${root}dist`
		: await mkdtemp(`${root}.core-build-`);
	try {
		await build({
			entry: { index: `${root}src/index.ts` },
			outDir: output,
			tsconfig: `${root}tsconfig.build.json`,
			platform: "node",
			target: "node24",
			format: ["esm"],
			splitting: false,
			dts: true,
			// Calls from the workspace root must keep package dependencies external too.
			external: [
				...Object.keys(manifest.dependencies ?? {}),
				...Object.keys(manifest.peerDependencies ?? {}),
			],
			clean: false,
			sourcemap: false,
			watch: options.watch ? `${root}src` : false,
		});
		if (!options.watch) {
			await mkdir(`${root}dist`, { recursive: true });
			for (const name of ["index.d.ts", "index.js"]) {
				await rename(`${output}/${name}`, `${root}dist/${name}`);
			}
		}
	} finally {
		if (!options.watch) await rm(output, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	await buildCore({ watch: process.argv.includes("--watch") });
}

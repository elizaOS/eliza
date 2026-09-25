/** Emits the runtime and explicit protocol leaves without duplicating module state. */
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const assets = [
	"catalog/generated.json",
	"catalog/curated-app-definitions.json",
	"catalog/channel-plugin-map.json",
	"catalog/provider-plugin-map.json",
	"catalog/short-id-plugin-map.json",
	"restart-exit-code.json",
];

async function run(command: string, args: string[]): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(command, args, { cwd: root, stdio: "inherit" });
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else
				reject(new Error(`Core build failed: ${command} (${signal ?? code})`));
		});
	});
}

async function filesUnder(directory: string, prefix = ""): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(path.join(directory, prefix), {
		withFileTypes: true,
	})) {
		const relative = path.join(prefix, entry.name);
		if (entry.isDirectory())
			files.push(...(await filesUnder(directory, relative)));
		else if (entry.isFile()) files.push(relative);
	}
	return files;
}

async function emitCore(): Promise<void> {
	const staging = await mkdtemp(path.join(root, ".core-build-"));
	const output = path.join(staging, "dist");
	try {
		await run("bun", [
			"x",
			"--no-install",
			"tsc6",
			"--noCheck",
			"-p",
			"tsconfig.emit.json",
			"--outDir",
			output,
		]);
		await run(process.execPath, [
			"../scripts/rewrite-dist-relative-imports-node-esm.ts",
			staging,
		]);
		for (const asset of assets) {
			await mkdir(path.dirname(path.join(output, asset)), { recursive: true });
			await cp(path.join(root, "src", asset), path.join(output, asset));
		}
		const files = await filesUnder(output);
		// Publish dependencies before the root entry, retaining complete old files
		// until each replacement is ready for concurrent package consumers.
		files.sort(
			(a, b) =>
				Number(a === "index.js" || a === "index.d.ts") -
					Number(b === "index.js" || b === "index.d.ts") || a.localeCompare(b),
		);
		const dist = path.join(root, "dist");
		await mkdir(dist, { recursive: true });
		for (const file of files) {
			await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
			await rename(path.join(output, file), path.join(dist, file));
		}
		const emitted = new Set(files);
		for (const file of await filesUnder(dist)) {
			if (!emitted.has(file)) await rm(path.join(dist, file));
		}
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

export async function buildCore(
	options: { watch?: boolean } = {},
): Promise<void> {
	await emitCore();
	if (!options.watch) return;
	let pending = false;
	let building = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	async function rebuild(): Promise<void> {
		if (building) return;
		building = true;
		try {
			while (pending) {
				pending = false;
				try {
					await emitCore();
					process.exitCode = 0;
				} catch (error) {
					console.error(error);
					process.exitCode = 1;
				}
			}
		} finally {
			building = false;
		}
	}
	function schedule(): void {
		pending = true;
		clearTimeout(timer);
		timer = setTimeout(() => {
			void rebuild();
		}, 100);
	}
	const sourceWatcher = watch(
		path.join(root, "src"),
		{ recursive: true },
		schedule,
	);
	const configWatcher = watch(root, (_event, filename) => {
		if (filename === "package.json" || filename?.startsWith("tsconfig"))
			schedule();
	});
	for (const watcher of [sourceWatcher, configWatcher]) {
		watcher.on("error", (error) => {
			console.error(error);
			process.exitCode = 1;
			sourceWatcher.close();
			configWatcher.close();
		});
	}
}

if (import.meta.main)
	await buildCore({ watch: process.argv.includes("--watch") });

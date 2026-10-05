import fs from "node:fs";
import path from "node:path";

type FsLike = Pick<typeof fs, "existsSync" | "readFileSync" | "statSync">;

export interface ElectrobunPreloadStatus {
	preloadPath: string;
	sourcePath: string;
	preloadExists: boolean;
	sourceExists: boolean;
	stale: boolean;
}

export function getElectrobunPreloadStatus(
	baseDir: string,
	fileSystem: FsLike = fs,
): ElectrobunPreloadStatus {
	const preloadPath = path.join(baseDir, "preload.js");
	const sourcePath = path.join(baseDir, "bridge", "electrobun-preload.ts");
	const preloadExists = fileSystem.existsSync(preloadPath);
	const sourceExists = fileSystem.existsSync(sourcePath);

	let stale = false;
	if (preloadExists && sourceExists) {
		stale =
			fileSystem.statSync(preloadPath).mtimeMs <
			fileSystem.statSync(sourcePath).mtimeMs;
	}

	return {
		preloadPath,
		sourcePath,
		preloadExists,
		sourceExists,
		stale,
	};
}

export function readBuiltPreloadScript(
	baseDir: string,
	fileSystem: FsLike = fs,
): string {
	const status = getElectrobunPreloadStatus(baseDir, fileSystem);

	if (!status.preloadExists) {
		throw new Error(
			`[Main] preload.js is missing at ${status.preloadPath}. From the repo root run \`bun run build:preload\` (or \`cd apps/app/electrobun && bun run build:preload\`).`,
		);
	}

	if (status.stale) {
		throw new Error(
			`[Main] preload.js is stale relative to ${status.sourcePath}. From the repo root run \`bun run build:preload\` (or \`cd apps/app/electrobun && bun run build:preload\`).`,
		);
	}

	const preload = fileSystem.readFileSync(status.preloadPath, "utf8");
	if (!preload.trim()) {
		throw new Error(
			`[Main] preload.js is empty at ${status.preloadPath}. From the repo root run \`bun run build:preload\` (or \`cd apps/app/electrobun && bun run build:preload\`).`,
		);
	}

	return preload;
}

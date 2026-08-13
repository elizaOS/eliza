/** Verifies Discord package resolution in real Bun child processes under development and default conditions. */

import { spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
let fixtureRoot: string;
let installedPackageRoot: string;

beforeAll(() => {
	fixtureRoot = mkdtempSync(path.join(tmpdir(), "discord-package-exports-"));
	installedPackageRoot = path.join(
		fixtureRoot,
		"node_modules/@elizaos/plugin-discord",
	);
	mkdirSync(path.join(installedPackageRoot, "dist"), { recursive: true });
	writeFileSync(
		path.join(installedPackageRoot, "package.json"),
		readFileSync(path.join(packageRoot, "package.json")),
	);
	writeFileSync(path.join(installedPackageRoot, "index.ts"), "export {};\n");
	writeFileSync(
		path.join(installedPackageRoot, "dist/index.js"),
		"export {};\n",
	);
});

afterAll(() => {
	rmSync(fixtureRoot, { recursive: true, force: true });
});

function resolvePackageRoot(conditions: string[] = []): string {
	const result = spawnSync(
		"bun",
		[
			...conditions.map((condition) => `--conditions=${condition}`),
			"--eval",
			"process.stdout.write(import.meta.resolve('@elizaos/plugin-discord'));",
		],
		{ cwd: fixtureRoot, encoding: "utf8", timeout: 30_000 },
	);

	expect(result.status, result.stderr).toBe(0);
	return fileURLToPath(result.stdout.trim());
}

describe("@elizaos/plugin-discord package exports", () => {
	it("resolves source for the development condition", () => {
		expect(path.normalize(resolvePackageRoot(["eliza-source"]))).toBe(
			path.normalize(realpathSync(path.join(installedPackageRoot, "index.ts"))),
		);
	});

	it("keeps default package resolution on the distributable entry", () => {
		expect(path.normalize(resolvePackageRoot())).toBe(
			path.normalize(
				realpathSync(path.join(installedPackageRoot, "dist/index.js")),
			),
		);
	});
});

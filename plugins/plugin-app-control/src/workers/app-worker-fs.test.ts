/**
 * Isolated bun:test coverage of the worker sandbox FS helper: real
 * files, pre-existing symlink escape, and a TOCTOU swap between
 * validation and the O_NOFOLLOW open. No runtime or vitest harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSandboxFs } from "./app-worker-fs.ts";

const dirs: string[] = [];

function sandbox(): { root: string; outside: string } {
	const root = mkdtempSync(path.join(tmpdir(), "app-worker-fs-"));
	dirs.push(root);
	const outside = path.join(tmpdir(), `app-worker-fs-out-${Date.now()}.txt`);
	writeFileSync(outside, "SECRET_PAYLOAD_TOCTOU_SWAP");
	dirs.push(outside);
	return { root, outside };
}

afterEach(() => {
	delete process.env.ELIZA_APP_WORKER_FS_TOCTOU_HOOK;
	delete process.env.ELIZA_APP_WORKER_FS_TOCTOU_TARGET;
	for (const entry of dirs.splice(0)) {
		rmSync(entry, { recursive: true, force: true });
	}
});

function fsFor(root: string) {
	return createSandboxFs({
		statePath: root,
		granted: true,
		declared: new Set(["read", "write"]),
	});
}

describe("app-worker-fs", () => {
	test("round-trips a regular file inside statePath", async () => {
		const { root } = sandbox();
		const file = path.join(root, "hello.txt");
		const sandboxFs = fsFor(root);
		await sandboxFs.writeFile(file, "from worker");
		expect(await sandboxFs.readFile(file)).toBe("from worker");
	});

	test("rejects a pre-existing symlink whose lexical name is inside statePath", async () => {
		const { root, outside } = sandbox();
		const link = path.join(root, "escape-link");
		symlinkSync(outside, link);
		const sandboxFs = fsFor(root);
		await expect(sandboxFs.readFile(link)).rejects.toThrow(
			"escapes the sandbox statePath",
		);
	});

	test("rejects a symlink swapped in after validation and before open", async () => {
		const { root, outside } = sandbox();
		const inside = path.join(root, "safe.txt");
		writeFileSync(inside, "inside-ok");
		process.env.ELIZA_APP_WORKER_FS_TOCTOU_HOOK = "1";
		process.env.ELIZA_APP_WORKER_FS_TOCTOU_TARGET = outside;
		const sandboxFs = fsFor(root);
		await expect(sandboxFs.readFile(inside)).rejects.toThrow(
			"escapes the sandbox statePath",
		);
		await expect(sandboxFs.readFile(inside)).rejects.not.toThrow(
			"SECRET_PAYLOAD_TOCTOU_SWAP",
		);

		rmSync(inside, { force: true });
		writeFileSync(inside, "inside-ok");
		await expect(sandboxFs.writeFile(inside, "overwrite")).rejects.toThrow(
			"escapes the sandbox statePath",
		);
	});

	test("rejects a lexical path outside statePath", async () => {
		const { root } = sandbox();
		const sandboxFs = fsFor(root);
		await expect(sandboxFs.readFile("/etc/passwd")).rejects.toThrow(
			"escapes the sandbox statePath",
		);
	});

	test("creates missing parent directories for writes inside the root", async () => {
		const { root } = sandbox();
		const nested = path.join(root, "a", "b", "c.txt");
		const sandboxFs = fsFor(root);
		await sandboxFs.writeFile(nested, "nested");
		expect(await sandboxFs.readFile(nested)).toBe("nested");
	});
});

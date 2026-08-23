/** Proves a second Bun process can reopen and fully traverse the PGLite ledger. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const dataDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "eliza-continuity-pglite-"),
);
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function child(mode: "write" | "read", envelope?: unknown) {
	const script = path.join(
		import.meta.dir,
		"session-summary-content-manifest.pglite-child.ts",
	);
	const result = Bun.spawnSync({
		cmd: [
			process.execPath,
			"--conditions=eliza-source",
			script,
			mode,
			dataDir,
			...(envelope
				? [Buffer.from(JSON.stringify(envelope)).toString("base64url")]
				: []),
		],
		cwd: path.resolve(import.meta.dir, "../../../../.."),
		env: { ...process.env, ELIZA_PGLITE_STORAGE: "disk" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = result.stdout.toString();
	if (result.exitCode !== 0)
		throw new Error(
			`continuity child failed (${mode}): ${result.stderr.toString()}\n${stdout}`,
		);
	const line = stdout
		.split("\n")
		.find((value) => value.startsWith("CONTINUITY_RESULT="));
	if (!line)
		throw new Error(`continuity child emitted no result (${mode}): ${stdout}`);
	return JSON.parse(line.slice("CONTINUITY_RESULT=".length));
}

describe("session-summary PGLite process continuity", () => {
	it("terminates the writer and reaches the late canary from a fresh reader", () => {
		const envelope = child("write");
		const result = child("read", envelope);
		expect(result.recordCount).toBe(80);
		expect(result.lateCanary).toMatch(/^document:/u);
	}, 180_000);
});

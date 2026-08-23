/** Proves a second Bun process can reopen and fully traverse the PGLite ledger. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const testDir = fileURLToPath(new URL(".", import.meta.url));
const dataDir = fs.mkdtempSync(
	path.join(os.tmpdir(), "eliza-continuity-pglite-"),
);
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function child(mode: "write" | "read", envelope?: unknown) {
	const script = path.join(
		testDir,
		"session-summary-content-manifest.pglite-child.ts",
	);
	const result = spawnSync(
		"bun",
		[
			"--conditions=eliza-source",
			script,
			mode,
			dataDir,
			...(envelope
				? [Buffer.from(JSON.stringify(envelope)).toString("base64url")]
				: []),
		],
		{
			cwd: path.resolve(testDir, "../../../../.."),
			env: { ...process.env, ELIZA_PGLITE_STORAGE: "disk" },
			encoding: "utf8",
		},
	);
	const stdout = result.stdout;
	if (result.status !== 0)
		throw new Error(
			`continuity child failed (${mode}): ${result.stderr}\n${stdout}`,
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

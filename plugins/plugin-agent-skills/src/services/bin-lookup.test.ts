/**
 * Tests for the shared PATH binary lookup — the sink for W1-005 (shell
 * injection via skill frontmatter `bins`). Runs the real `which` probe with
 * registry-style adversarial names and proves none of them reach a shell:
 * payload canaries are never created and metacharacter names are rejected.
 * Real host processes, no mocks.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { binaryExistsInPath } from "./bin-lookup";

const canary = path.join(
	os.tmpdir(),
	`bin-lookup-canary-${process.pid}-${Date.now()}`,
);

describe("binaryExistsInPath", () => {
	it("finds a real binary in PATH", async () => {
		const probe = process.platform === "win32" ? "cmd" : "sh";
		expect(await binaryExistsInPath(probe)).toBe(true);
	});

	it("returns false for a plausible but nonexistent binary", async () => {
		expect(await binaryExistsInPath("not-a-real-binary-7f3a9c2e1d")).toBe(
			false,
		);
	});

	it("rejects shell metacharacter payloads without executing them", async () => {
		const payloads = [
			`zzz; touch "${canary}"; #`,
			`$(touch "${canary}")`,
			`\`touch "${canary}"\``,
			`zzz | touch "${canary}"`,
			`zzz && touch "${canary}"`,
			`zzz > "${canary}"`,
		];

		for (const payload of payloads) {
			expect(await binaryExistsInPath(payload)).toBe(false);
		}

		// If any payload had been interpreted by a shell, the canary exists.
		expect(fs.existsSync(canary)).toBe(false);
	});

	it("rejects whitespace, path separators, and empty names", async () => {
		for (const name of ["two words", "/bin/sh", "../sh", "", "tab\tname"]) {
			expect(await binaryExistsInPath(name)).toBe(false);
		}
	});

	it("rejects option-like names so `which` cannot be fed flags", async () => {
		// Without the allowlist, `which --help` exits 0 and the probe would
		// falsely report a binary named "--help" as present.
		for (const name of ["--help", "-rf", "--version"]) {
			expect(await binaryExistsInPath(name)).toBe(false);
		}
	});
});

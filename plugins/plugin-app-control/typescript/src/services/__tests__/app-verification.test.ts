/**
 * @module plugin-app-control/services/__tests__/app-verification
 *
 * Unit tests for AppVerificationService.fast profile against synthetic
 * workdirs. Each test materializes its own temp project with a minimal
 * package.json that wires `typecheck` / `lint` to throwaway shell scripts,
 * which lets us assert pass/fail behavior without depending on a real tsc
 * or eslint install in the verification target.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, describe, expect, it } from "vitest";
import { AppVerificationService } from "../app-verification.js";

const STATE_DIR = mkdtempSync(path.join(tmpdir(), "app-verify-state-"));
process.env.MILADY_STATE_DIR = STATE_DIR;

const noopRuntime = {} as IAgentRuntime;

function writePackage(
	dir: string,
	scripts: Record<string, string>,
	name = "fixture-app",
): void {
	writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify({ name, version: "0.0.0", scripts }, null, 2),
		"utf8",
	);
}

let shimCounter = 0;
function makeNodeShim(dir: string, exitCode: number, stdout: string): string {
	// Each shim gets a unique filename so multiple shims can coexist in the
	// same workdir (e.g. distinct typecheck vs lint scripts).
	shimCounter += 1;
	const file = path.join(dir, `shim-${shimCounter}.mjs`);
	writeFileSync(
		file,
		[
			"import process from 'node:process';",
			`process.stdout.write(${JSON.stringify(stdout)});`,
			`process.exit(${exitCode});`,
		].join("\n"),
		"utf8",
	);
	return file;
}

describe("AppVerificationService.verifyApp (fast profile)", () => {
	const service = new AppVerificationService(noopRuntime);

	afterAll(async () => {
		await service.cleanup();
	});

	it("resolves to verdict=pass when typecheck and lint succeed", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-pass-"));
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		writePackage(workdir, {
			typecheck: `node ${JSON.stringify(passShim).replace(/^"|"$/g, "")}`,
			lint: `node ${JSON.stringify(passShim).replace(/^"|"$/g, "")}`,
		});

		const result = await service.verifyApp({
			workdir,
			profile: "fast",
			runId: "pass-fixture",
			packageManager: "npm",
		});

		expect(result.verdict).toBe("pass");
		expect(result.checks).toHaveLength(2);
		const typecheck = result.checks.find((c) => c.kind === "typecheck");
		const lint = result.checks.find((c) => c.kind === "lint");
		expect(typecheck?.passed).toBe(true);
		expect(lint?.passed).toBe(true);
		expect(result.runId).toBe("pass-fixture");
	}, 30_000);

	it("returns verdict=fail with diagnostics when typecheck fails", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-fail-"));
		// Emit a tsc-style diagnostic so the parser can populate `diagnostics`,
		// then exit non-zero so the pipeline records a hard failure.
		const failOutput =
			"src/plugin.ts(42,5): error TS2339: Property 'foo' does not exist on type 'AppMeta'.\n";
		const failShim = makeNodeShim(workdir, 1, failOutput);
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		writePackage(workdir, {
			typecheck: `node ${JSON.stringify(failShim).replace(/^"|"$/g, "")}`,
			lint: `node ${JSON.stringify(passShim).replace(/^"|"$/g, "")}`,
		});

		const result = await service.verifyApp({
			workdir,
			profile: "fast",
			runId: "fail-fixture",
			packageManager: "npm",
		});

		expect(result.verdict).toBe("fail");
		const typecheck = result.checks.find((c) => c.kind === "typecheck");
		expect(typecheck).toBeDefined();
		expect(typecheck?.passed).toBe(false);
		expect(typecheck?.diagnostics?.length ?? 0).toBeGreaterThan(0);
		const firstDiag = typecheck?.diagnostics?.[0];
		expect(firstDiag?.file).toBe("src/plugin.ts");
		expect(firstDiag?.line).toBe(42);
		expect(firstDiag?.severity).toBe("error");
		// Hard-fail at typecheck must short-circuit the lint check.
		expect(result.checks.find((c) => c.kind === "lint")).toBeUndefined();
		expect(result.retryablePromptForChild).toContain("typecheck");
		expect(result.retryablePromptForChild).toContain("Property 'foo'");
	}, 30_000);

	it("treats a failing lint as soft-fail (verdict still pass)", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-lint-soft-"));
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		const lintShim = makeNodeShim(workdir, 1, "noisy lint warnings\n");
		writePackage(workdir, {
			typecheck: `node ${JSON.stringify(passShim).replace(/^"|"$/g, "")}`,
			lint: `node ${JSON.stringify(lintShim).replace(/^"|"$/g, "")}`,
		});

		const result = await service.verifyApp({
			workdir,
			profile: "fast",
			runId: "lint-soft-fixture",
			packageManager: "npm",
		});

		expect(result.verdict).toBe("pass");
		const lint = result.checks.find((c) => c.kind === "lint");
		expect(lint?.passed).toBe(false);
		// Lint failure must not short-circuit subsequent checks (none here, but
		// confirms the pipeline did not abort prematurely).
		expect(result.checks).toHaveLength(2);
	}, 30_000);

	// Ensure the temp state-dir env stays set across tests (keep the dir alive
	// in scope so it's not gc'd into oblivion).
	it("persisted verification artifacts under MILADY_STATE_DIR", () => {
		expect(process.env.MILADY_STATE_DIR).toBe(STATE_DIR);
	});
});

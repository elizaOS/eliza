/**
 * @module plugin-app-control/services/__tests__/app-verification
 *
 * Unit tests for AppVerificationService.fast profile against synthetic
 * workdirs. Each test materializes its own temp project with a minimal
 * package.json that wires `typecheck` / `lint` to throwaway shell scripts,
 * which lets us assert pass/fail behavior without depending on a real tsc
 * or eslint install in the verification target.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
	elizaos?: Record<string, unknown>,
): void {
	writeFileSync(
		path.join(dir, "package.json"),
		JSON.stringify(
			{ name, version: "0.0.0", scripts, ...(elizaos ? { elizaos } : {}) },
			null,
			2,
		),
		"utf8",
	);
}

function nodeCommand(file: string): string {
	return `node ${JSON.stringify(file)}`;
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
			typecheck: nodeCommand(passShim),
			lint: nodeCommand(passShim),
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
			typecheck: nodeCommand(failShim),
			lint: nodeCommand(passShim),
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

	it("treats a failing lint as a hard failure", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-lint-hard-"));
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		const lintShim = makeNodeShim(workdir, 1, "noisy lint warnings\n");
		writePackage(workdir, {
			typecheck: nodeCommand(passShim),
			lint: nodeCommand(lintShim),
		});

		const result = await service.verifyApp({
			workdir,
			profile: "fast",
			runId: "lint-hard-fixture",
			packageManager: "npm",
		});

		expect(result.verdict).toBe("fail");
		const lint = result.checks.find((c) => c.kind === "lint");
		expect(lint?.passed).toBe(false);
		expect(result.checks).toHaveLength(2);
	}, 30_000);

	it("passes structured proof when files and test counts match disk output", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-proof-pass-"));
		mkdirSync(path.join(workdir, "src"));
		writeFileSync(
			path.join(workdir, "src", "index.ts"),
			"export const ok = true;\n",
		);
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		const testShim = makeNodeShim(
			workdir,
			0,
			[
				" ✓ tests/index.test.ts (2 tests)",
				"",
				" Test Files  1 passed (1)",
				"      Tests  2 passed (2)",
				"",
			].join("\n"),
		);
		writePackage(workdir, {
			typecheck: nodeCommand(passShim),
			lint: nodeCommand(passShim),
			test: nodeCommand(testShim),
		});

		const result = await service.verifyApp({
			workdir,
			checks: [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }],
			runId: "proof-pass-fixture",
			packageManager: "npm",
			requireStructuredProof: true,
			structuredProof: {
				kind: "APP_CREATE_DONE",
				appName: "fixture-app",
				files: ["src/index.ts", "package.json"],
				typecheck: "ok",
				lint: "ok",
				tests: { passed: 2, failed: 0 },
			},
		});

		expect(result.verdict).toBe("pass");
		const test = result.checks.find((c) => c.kind === "test");
		expect(test?.testSummary).toEqual({ passed: 2, failed: 0 });
		const proof = result.checks.find((c) => c.kind === "structured-proof");
		expect(proof?.passed).toBe(true);
	}, 30_000);

	it("rejects legacy structured proof fields", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-proof-legacy-"));
		mkdirSync(path.join(workdir, "src"));
		writeFileSync(
			path.join(workdir, "src", "index.ts"),
			"export const ok = true;\n",
		);
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		const testShim = makeNodeShim(
			workdir,
			0,
			" Test Files  1 passed (1)\n      Tests  1 passed (1)\n",
		);
		writePackage(workdir, {
			typecheck: nodeCommand(passShim),
			lint: nodeCommand(passShim),
			test: nodeCommand(testShim),
		});

		const result = await service.verifyApp({
			workdir,
			checks: [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }],
			runId: "proof-legacy-fixture",
			packageManager: "npm",
			requireStructuredProof: true,
			structuredProof: {
				kind: "APP_CREATE_DONE",
				name: "fixture-app",
				appName: "fixture-app",
				files: ["src/index.ts"],
				testsPassed: 1,
				lintClean: true,
				typecheck: "ok",
				lint: "ok",
				tests: { passed: 1, failed: 0 },
			},
		});

		expect(result.verdict).toBe("fail");
		const proof = result.checks.find((c) => c.kind === "structured-proof");
		expect(proof?.output).toContain("legacy field name");
		expect(proof?.output).toContain("legacy field testsPassed");
		expect(proof?.output).toContain("legacy field lintClean");
	}, 30_000);

	it("fails structured proof when claimed files are missing or empty", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-proof-files-"));
		mkdirSync(path.join(workdir, "src"));
		writeFileSync(path.join(workdir, "src", "empty.ts"), "");
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		const testShim = makeNodeShim(
			workdir,
			0,
			" Test Files  1 passed (1)\n      Tests  1 passed (1)\n",
		);
		writePackage(workdir, {
			typecheck: nodeCommand(passShim),
			lint: nodeCommand(passShim),
			test: nodeCommand(testShim),
		});

		const result = await service.verifyApp({
			workdir,
			checks: [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }],
			runId: "proof-files-fixture",
			packageManager: "npm",
			requireStructuredProof: true,
			structuredProof: {
				kind: "APP_CREATE_DONE",
				appName: "fixture-app",
				files: ["src/empty.ts", "src/missing.ts"],
				typecheck: "ok",
				lint: "ok",
				tests: { passed: 1, failed: 0 },
			},
		});

		expect(result.verdict).toBe("fail");
		const proof = result.checks.find((c) => c.kind === "structured-proof");
		expect(proof?.output).toContain("src/empty.ts is empty");
		expect(proof?.output).toContain("src/missing.ts does not exist");
	}, 30_000);

	it("fails structured proof when test count cannot be proven", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-proof-count-"));
		mkdirSync(path.join(workdir, "src"));
		writeFileSync(
			path.join(workdir, "src", "index.ts"),
			"export const ok = true;\n",
		);
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		const testShim = makeNodeShim(workdir, 0, "tests ok\n");
		writePackage(workdir, {
			typecheck: nodeCommand(passShim),
			lint: nodeCommand(passShim),
			test: nodeCommand(testShim),
		});

		const result = await service.verifyApp({
			workdir,
			checks: [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }],
			runId: "proof-count-fixture",
			packageManager: "npm",
			requireStructuredProof: true,
			structuredProof: {
				kind: "APP_CREATE_DONE",
				appName: "fixture-app",
				files: ["src/index.ts"],
				typecheck: "ok",
				lint: "ok",
				tests: { passed: 1, failed: 0 },
			},
		});

		expect(result.verdict).toBe("fail");
		const proof = result.checks.find((c) => c.kind === "structured-proof");
		expect(proof?.output).toContain("Cannot prove tests.passed");
	}, 30_000);

	it("uses plugin proof instructions and runs tests for plugin projects", async () => {
		const workdir = mkdtempSync(path.join(tmpdir(), "verify-plugin-proof-"));
		const passShim = makeNodeShim(workdir, 0, "ok\n");
		const testShim = makeNodeShim(
			workdir,
			0,
			" Test Files  1 passed (1)\n      Tests  1 passed (1)\n",
		);
		writePackage(
			workdir,
			{
				typecheck: nodeCommand(passShim),
				lint: nodeCommand(passShim),
				test: nodeCommand(testShim),
			},
			"@elizaos/plugin-fixture",
			{ plugin: { displayName: "Fixture" } },
		);

		const result = await service.verifyApp({
			workdir,
			profile: "fast",
			runId: "plugin-proof-fixture",
			packageManager: "npm",
		});

		expect(result.verdict).toBe("fail");
		expect(result.checks.map((check) => check.kind)).toEqual([
			"typecheck",
			"lint",
			"test",
			"structured-proof",
		]);
		expect(result.retryablePromptForChild).toContain("PLUGIN_CREATE_DONE");
	}, 30_000);

	// Ensure the temp state-dir env stays set across tests (keep the dir alive
	// in scope so it's not gc'd into oblivion).
	it("persisted verification artifacts under MILADY_STATE_DIR", () => {
		expect(process.env.MILADY_STATE_DIR).toBe(STATE_DIR);
	});
});

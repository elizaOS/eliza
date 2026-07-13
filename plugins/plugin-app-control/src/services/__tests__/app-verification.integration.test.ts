/**
 * Exercises AppVerificationService against real temporary projects and local toolchain commands.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, describe, expect } from "vitest";
import { itIf } from "../../../../../packages/app-core/test/helpers/conditional-tests";
import { AppVerificationService } from "../app-verification.js";

const execFileAsync = promisify(execFile);

async function commandAvailable(
	file: string,
	args: string[],
): Promise<boolean> {
	try {
		await execFileAsync(file, args, { timeout: 5_000 });
		return true;
	} catch {
		return false;
	}
}

const STATE_DIR = mkdtempSync(path.join(tmpdir(), "app-verify-int-state-"));
process.env.ELIZA_STATE_DIR = STATE_DIR;

// Hoist availability checks to module scope so itIf gates can read them at
// test-registration time. Top-level await is supported by vitest's ESM runner.
const bunAvailable = await commandAvailable("bun", ["--version"]);
const npmAvailable = await commandAvailable("npm", ["--version"]);
const pkgManagerAvailable = bunAvailable || npmAvailable;
if (!pkgManagerAvailable) {
	process.env.SKIP_REASON ||= "bun or npm required to verify scaffolds";
}

const noopRuntime = {} as IAgentRuntime;

const PASS_TS = `
export type Greeting = { hello: string };
export const hello: Greeting = { hello: "world" };
`;

const FAIL_TS = `
export type Greeting = { hello: string };
// hello.foo does not exist on Greeting — this should be a TS2339 error.
export const broken: number = ({ hello: "world" } as Greeting).foo;
`;

const PASS_SHIM_JS = `process.stdout.write("lint ok\\n"); process.exit(0);\n`;
const TEST_SHIM_JS = `process.stdout.write(" Tests  2 passed (2)\\n"); process.exit(0);\n`;
const BUILD_SHIM_JS = `process.stdout.write("build ok\\n"); process.exit(0);\n`;

function writeMinimalTsProject(workdir: string, source: string): void {
	writeFileSync(path.join(workdir, "src.ts"), source, "utf8");
	writeFileSync(
		path.join(workdir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "es2022",
					module: "esnext",
					moduleResolution: "bundler",
					strict: true,
					noEmit: true,
					skipLibCheck: true,
					isolatedModules: true,
				},
				include: ["src.ts"],
			},
			null,
			2,
		),
		"utf8",
	);

	// Lint: a tiny shim so we don't depend on eslint being installed.
	const lintShim = path.join(workdir, "lint-shim.mjs");
	writeFileSync(lintShim, PASS_SHIM_JS, "utf8");
	const testShim = path.join(workdir, "test-shim.mjs");
	writeFileSync(testShim, TEST_SHIM_JS, "utf8");
	const buildShim = path.join(workdir, "build-shim.mjs");
	writeFileSync(buildShim, BUILD_SHIM_JS, "utf8");

	writeFileSync(
		path.join(workdir, "package.json"),
		JSON.stringify(
			{
				name: "verify-int-fixture",
				version: "0.0.0",
				private: true,
				scripts: {
					// typecheck: invoke the locally-resolvable tsc via npx. If typescript
					// is not installed locally, npx will download it on the fly — slow
					// but acceptable for this single-file integration check.
					typecheck:
						"npx --yes -p typescript@5.6.2 tsc --noEmit -p tsconfig.json",
					lint: `node ${JSON.stringify(lintShim).slice(1, -1)}`,
					test: `node ${JSON.stringify(testShim).slice(1, -1)}`,
					build: `node ${JSON.stringify(buildShim).slice(1, -1)}`,
				},
			},
			null,
			2,
		),
		"utf8",
	);
}

// Integration tests below scaffold a temp project that depends on `npm` /
// `npx` resolving in PATH and downloading TypeScript via the network. On
// Windows the npm shim resolution + ad-hoc tsc install is flaky in CI;
// the unit tests in `app-verification.test.ts` cover the same code paths
// without network/shim dependencies. Skip the integration suite on
// Windows hosts and keep the cross-platform unit coverage authoritative.
const describeIntegration =
	process.platform === "win32" ? describe.skip : describe;

describeIntegration("AppVerificationService.verifyApp (integration)", () => {
	const service = new AppVerificationService(noopRuntime);

	afterAll(async () => {
		await service.cleanup();
	});

	itIf(pkgManagerAvailable)(
		"returns verdict=pass for a real TS project that typechecks cleanly",
		async () => {
			const workdir = mkdtempSync(path.join(tmpdir(), "verify-int-pass-"));
			writeMinimalTsProject(workdir, PASS_TS);

			const result = await service.verifyApp({
				workdir,
				profile: "fast",
				runId: "int-pass",
				packageManager: "npm",
			});

			expect(result.verdict).toBe("pass");
			const typecheck = result.checks.find((c) => c.kind === "typecheck");
			expect(typecheck?.passed).toBe(true);
		},
		120_000,
	);

	itIf(pkgManagerAvailable)(
		"builds a verified plugin before reporting a pass",
		async () => {
			const workdir = mkdtempSync(path.join(tmpdir(), "verify-plugin-build-"));
			writeMinimalTsProject(workdir, PASS_TS);

			const result = await service.verifyPlugin({
				workdir,
				profile: "full",
				runId: "int-plugin-build",
				packageManager: "npm",
				structuredProof: {
					kind: "PLUGIN_CREATE_DONE",
					pluginName: "verify-int-fixture",
					files: ["src.ts"],
					typecheck: "ok",
					lint: "ok",
					tests: { passed: 2, failed: 0 },
				},
			});

			expect(result.verdict).toBe("pass");
			expect(result.checks.map((check) => check.kind)).toEqual([
				"typecheck",
				"lint",
				"test",
				"build",
				"structured-proof",
			]);
			expect(
				result.checks.find((check) => check.kind === "build")?.passed,
			).toBe(true);
		},
		120_000,
	);

	itIf(pkgManagerAvailable)(
		"returns verdict=fail with non-empty diagnostics when TS has a type error",
		async () => {
			const workdir = mkdtempSync(path.join(tmpdir(), "verify-int-fail-"));
			writeMinimalTsProject(workdir, FAIL_TS);

			const result = await service.verifyApp({
				workdir,
				profile: "fast",
				runId: "int-fail",
				packageManager: "npm",
			});

			expect(result.verdict).toBe("fail");
			const typecheck = result.checks.find((c) => c.kind === "typecheck");
			expect(typecheck).toBeDefined();
			expect(typecheck?.passed).toBe(false);
			expect((typecheck?.diagnostics ?? []).length).toBeGreaterThan(0);
			expect(result.retryablePromptForChild.toLowerCase()).toContain(
				"typecheck",
			);
			expect(result.retryablePromptForChild).toContain("bun run build");
		},
		120_000,
	);

	itIf(pkgManagerAvailable)(
		"fails structured proof with actual vs claimed test-count diagnostics",
		async () => {
			const workdir = mkdtempSync(path.join(tmpdir(), "verify-int-proof-"));
			writeMinimalTsProject(workdir, PASS_TS);

			const result = await service.verifyApp({
				workdir,
				profile: "full",
				runId: "int-proof-mismatch",
				packageManager: "npm",
				structuredProof: {
					kind: "APP_CREATE_DONE",
					appName: "verify-int-fixture",
					files: ["src.ts"],
					typecheck: "ok",
					lint: "ok",
					tests: { passed: 1, failed: 0 },
				},
			});

			expect(result.verdict).toBe("fail");
			const proof = result.checks.find((c) => c.kind === "structured-proof");
			expect(proof?.passed).toBe(false);
			expect(proof?.diagnostics?.map((diag) => diag.message)).toContain(
				"structured proof tests.passed=1 does not match verified test output passed=2",
			);
			expect(result.retryablePromptForChild).toContain(
				'tests":{"passed":<exact passed count>',
			);
		},
		120_000,
	);

	itIf(pkgManagerAvailable)(
		"fails structured proof with explicit expected-vs-actual kind and name-field diagnostics",
		async () => {
			const workdir = mkdtempSync(path.join(tmpdir(), "verify-int-kind-"));
			writeMinimalTsProject(workdir, PASS_TS);

			const result = await service.verifyApp({
				workdir,
				profile: "full",
				runId: "int-proof-kind-mismatch",
				packageManager: "npm",
				projectKind: "app",
				structuredProof: {
					kind: "PLUGIN_CREATE_DONE",
					pluginName: "verify-int-fixture",
					files: ["src.ts"],
					typecheck: "ok",
					lint: "ok",
					tests: { passed: 2, failed: 0 },
				},
			});

			expect(result.verdict).toBe("fail");
			const proof = result.checks.find((c) => c.kind === "structured-proof");
			expect(proof?.passed).toBe(false);
			expect(proof?.diagnostics?.map((diag) => diag.message)).toEqual(
				expect.arrayContaining([
					"structured proof kind must be APP_CREATE_DONE; received PLUGIN_CREATE_DONE",
					"structured proof must include a non-empty appName",
					"structured proof pluginName is invalid for APP_CREATE_DONE",
				]),
			);
			expect(result.retryablePromptForChild).toContain(
				'APP_CREATE_DONE {"appName":"<package-name>"',
			);
		},
		120_000,
	);
});

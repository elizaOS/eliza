/**
 * @module plugin-app-control/services/__tests__/app-verification.integration
 *
 * Integration test for AppVerificationService.verifyApp against a real
 * temp project on disk that uses real `tsc` for typecheck. We do NOT rely
 * on a global eslint install — lint is wired to a no-op shim so the fast
 * profile (typecheck + lint) returns a pure typecheck verdict.
 *
 * The test is gated on `bun --version` succeeding because the verifier's
 * default packageManager detection picks bun when bun.lockb is present, and
 * we explicitly pass packageManager: "npm" to keep the surface narrow. We
 * still need npx to be available to run the local tsc; if npx + npm aren't
 * on PATH the test is skipped to keep CI portable.
 */

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
process.env.MILADY_STATE_DIR = STATE_DIR;

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
				},
			},
			null,
			2,
		),
		"utf8",
	);
}

describe("AppVerificationService.verifyApp (integration)", () => {
	let bunAvailable = false;
	let npmAvailable = false;
	const service = new AppVerificationService(noopRuntime);

	beforeAll(async () => {
		bunAvailable = await commandAvailable("bun", ["--version"]);
		npmAvailable = await commandAvailable("npm", ["--version"]);
	});

	afterAll(async () => {
		await service.cleanup();
	});

	it("returns verdict=pass for a real TS project that typechecks cleanly", async () => {
		if (!bunAvailable && !npmAvailable) {
			// Neither bun nor npm available — this environment cannot run the test.
			// Skip is the right call per the test plan.
			return;
		}
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
	}, 120_000);

	it("returns verdict=fail with non-empty diagnostics when TS has a type error", async () => {
		if (!bunAvailable && !npmAvailable) {
			return;
		}
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
		expect(result.retryablePromptForChild.toLowerCase()).toContain("typecheck");
	}, 120_000);
});

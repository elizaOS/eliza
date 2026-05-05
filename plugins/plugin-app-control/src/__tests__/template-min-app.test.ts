/**
 * Template validation: scaffolds the real `eliza/templates/min-project` and
 * `eliza/templates/min-plugin` templates into a tempdir, replaces the
 * placeholders the way the create flow's `copyTemplate()` does, and runs
 * the AppVerificationService pipeline against the result.
 *
 * Without this test, a typo or stale dep in either template would only
 * surface when a real spawned coding agent failed verification and the
 * parent retried 3 times before escalating to the user.
 *
 * The tempdirs are created at the same depth as real generated apps and
 * plugins, so template-relative tsconfig paths match production scaffolds.
 * Skipped if no package manager is on PATH.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppVerificationService } from "../services/app-verification.js";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
// __tests__ → src → typescript → plugin-app-control → plugins → eliza
const ELIZA_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const APP_TEMPLATE_DIR = path.join(ELIZA_ROOT, "templates", "min-project");
const PLUGIN_TEMPLATE_DIR = path.join(ELIZA_ROOT, "templates", "min-plugin");
const TEST_RUN_ID = `${process.pid}-${Date.now()}-${randomUUID()}`;
const APP_TMP_PARENT = path.join(ELIZA_ROOT, "apps");
const PLUGIN_TMP_PARENT = path.join(ELIZA_ROOT, "plugins");
const TMP_DIR_PREFIX = `.test-tmp-templates-${TEST_RUN_ID}`;

async function packageManagerAvailable(): Promise<boolean> {
	for (const pm of ["bun", "pnpm", "npm"]) {
		try {
			await execFileAsync(pm, ["--version"], { timeout: 5_000 });
			return true;
		} catch {
			// try next
		}
	}
	return false;
}

const skip =
	!(await packageManagerAvailable()) ||
	!existsSync(APP_TEMPLATE_DIR) ||
	!existsSync(PLUGIN_TEMPLATE_DIR);

function copyTemplateAndReplace(
	src: string,
	dest: string,
	replacements: Record<string, string>,
): void {
	if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
	for (const entry of readdirSync(src)) {
		const from = path.join(src, entry);
		const to = path.join(dest, entry);
		const stat = statSync(from);
		if (stat.isDirectory()) {
			copyTemplateAndReplace(from, to, replacements);
		} else if (stat.isFile()) {
			const raw = readFileSync(from);
			const text = raw.toString("utf8");
			// Lossless utf8 round-trip check: skip placeholder rewrite for
			// binaries (e.g. PNGs).
			if (Buffer.byteLength(text, "utf8") === raw.length) {
				let rewritten = text;
				for (const [token, value] of Object.entries(replacements)) {
					rewritten = rewritten.split(token).join(value);
				}
				writeFileSync(to, rewritten, "utf8");
			} else {
				cpSync(from, to);
			}
		}
	}
}

beforeAll(() => {
	if (skip) return;
	mkdirSync(APP_TMP_PARENT, { recursive: true });
	mkdirSync(PLUGIN_TMP_PARENT, { recursive: true });
});

afterAll(() => {
	for (const parent of [APP_TMP_PARENT, PLUGIN_TMP_PARENT]) {
		for (const entry of readdirSync(parent)) {
			if (entry.startsWith(TMP_DIR_PREFIX)) {
				rmSync(path.join(parent, entry), { recursive: true, force: true });
			}
		}
	}
});

function createScaffoldDir(parent: string, prefix: string): string {
	return mkdtempSync(path.join(parent, `${TMP_DIR_PREFIX}-${prefix}-`));
}

describe.skipIf(skip)(
	"templates/min-project — scaffolds into a verifiable workspace",
	() => {
		const service = new AppVerificationService();

		afterAll(async () => {
			await service.cleanup?.();
		});

		it("placeholders are present in the source template", () => {
			const pkgRaw = readFileSync(
				path.join(APP_TEMPLATE_DIR, "package.json"),
				"utf8",
			);
			const pluginRaw = readFileSync(
				path.join(APP_TEMPLATE_DIR, "src", "plugin.ts"),
				"utf8",
			);
			expect(pkgRaw).toContain("__APP_NAME__");
			expect(pkgRaw).toContain("__APP_DISPLAY_NAME__");
			expect(pluginRaw).toContain("__APP_NAME__");
		});

		// Single full-pipeline run (typecheck + lint + test) is a strict
		// superset of the old "fast profile" run, so we don't pay for the
		// scaffold/tsc/biome cold-start twice. If you need to debug just
		// typecheck+lint, run with `--testNamePattern` and a custom checks
		// override locally.
		it("scaffolds + typechecks + lints + tests clean", async () => {
			const scaffoldDir = createScaffoldDir(APP_TMP_PARENT, "min-project");

			try {
				copyTemplateAndReplace(APP_TEMPLATE_DIR, scaffoldDir, {
					__APP_NAME__: "scaffold-validation-app",
					__APP_DISPLAY_NAME__: "Scaffold Validation App",
				});

				const pkgRaw = readFileSync(
					path.join(scaffoldDir, "package.json"),
					"utf8",
				);
				expect(pkgRaw).not.toContain("__APP_NAME__");
				expect(pkgRaw).toContain("scaffold-validation-app");

				const result = await service.verifyApp({
					workdir: scaffoldDir,
					appName: "scaffold-validation-app",
					checks: [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }],
					runId: `template-min-project-with-tests-${TEST_RUN_ID}`,
				});

				if (result.verdict !== "pass") {
					const summary = result.checks
						.map(
							(c) =>
								`  - ${c.kind}: ${c.passed ? "pass" : "FAIL"} (${c.durationMs}ms)`,
						)
						.join("\n");
					throw new Error(
						`min-project template failed verification.\nChecks:\n${summary}\n\nRetryable prompt:\n${result.retryablePromptForChild}`,
					);
				}
				expect(result.verdict).toBe("pass");
				expect(result.checks.find((c) => c.kind === "typecheck")?.passed).toBe(
					true,
				);
				expect(result.checks.find((c) => c.kind === "lint")?.passed).toBe(true);
				expect(result.checks.find((c) => c.kind === "test")?.passed).toBe(true);
			} finally {
				rmSync(scaffoldDir, { recursive: true, force: true });
			}
		}, 240_000);
	},
);

describe.skipIf(skip)(
	"templates/min-plugin — scaffolds into a verifiable workspace",
	() => {
		const service = new AppVerificationService();

		afterAll(async () => {
			await service.cleanup?.();
		});

		it("placeholders are present in the source template", () => {
			const pkgRaw = readFileSync(
				path.join(PLUGIN_TEMPLATE_DIR, "package.json"),
				"utf8",
			);
			const indexRaw = readFileSync(
				path.join(PLUGIN_TEMPLATE_DIR, "src", "index.ts"),
				"utf8",
			);
			expect(pkgRaw).toContain("__PLUGIN_NAME__");
			expect(pkgRaw).toContain("__PLUGIN_DISPLAY_NAME__");
			expect(indexRaw).toContain("__PLUGIN_NAME__");
		});

		it("scaffolds + typechecks + lints + tests clean", async () => {
			const scaffoldDir = createScaffoldDir(PLUGIN_TMP_PARENT, "min-plugin");

			try {
				copyTemplateAndReplace(PLUGIN_TEMPLATE_DIR, scaffoldDir, {
					__PLUGIN_NAME__: "scaffold-validation-plugin",
					__PLUGIN_DISPLAY_NAME__: "Scaffold Validation Plugin",
				});

				const pkgRaw = readFileSync(
					path.join(scaffoldDir, "package.json"),
					"utf8",
				);
				expect(pkgRaw).not.toContain("__PLUGIN_NAME__");
				expect(pkgRaw).toContain("scaffold-validation-plugin");

				const result = await service.verifyApp({
					workdir: scaffoldDir,
					appName: "scaffold-validation-plugin",
					checks: [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }],
					// Plugin verifyApp normally requires the agent to emit a
					// PLUGIN_CREATE_DONE structured-proof line; for template
					// validation we're not running an agent that emits one,
					// so opt out.
					requireStructuredProof: false,
					runId: `template-min-plugin-with-tests-${TEST_RUN_ID}`,
				});

				if (result.verdict !== "pass") {
					const summary = result.checks
						.map(
							(c) =>
								`  - ${c.kind}: ${c.passed ? "pass" : "FAIL"} (${c.durationMs}ms)`,
						)
						.join("\n");
					throw new Error(
						`min-plugin template failed verification.\nChecks:\n${summary}\n\nRetryable prompt:\n${result.retryablePromptForChild}`,
					);
				}
				expect(result.verdict).toBe("pass");
				expect(result.checks.find((c) => c.kind === "typecheck")?.passed).toBe(
					true,
				);
				expect(result.checks.find((c) => c.kind === "lint")?.passed).toBe(true);
				expect(result.checks.find((c) => c.kind === "test")?.passed).toBe(true);
			} finally {
				rmSync(scaffoldDir, { recursive: true, force: true });
			}
		}, 240_000);
	},
);

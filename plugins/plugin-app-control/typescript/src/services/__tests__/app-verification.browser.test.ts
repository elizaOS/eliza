/**
 * @module plugin-app-control/services/__tests__/app-verification.browser
 *
 * Tests for the browser-verification fail-closed behavior. We exercise
 * `runBrowserCheck` directly via the `__runBrowserCheckForTests` seam so
 * we don't have to spin up a real launch + dashboard API.
 *
 * These tests cover:
 *   - viewerUrl missing → hard fail with diagnostic.
 *   - puppeteer-core missing + MILADY_BROWSER_VERIFY_OPTIONAL=1 → soft skip
 *     (legacy behavior is now opt-in only).
 *   - puppeteer-core missing without the env var → hard fail with the
 *     install/opt-out diagnostic.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__runBrowserCheckForTests,
	__setBrowserModuleLoaderForTests,
	type LaunchContext,
} from "../app-verification.js";
import { ensureVerificationDir } from "../verification-helpers.js";

const STATE_DIR = mkdtempSync(path.join(tmpdir(), "app-verify-browser-state-"));
process.env.MILADY_STATE_DIR = STATE_DIR;

async function makeRunDir(name: string): Promise<string> {
	return ensureVerificationDir(name);
}

describe("runBrowserCheck (fail-closed semantics)", () => {
	beforeEach(() => {
		// Default: no puppeteer-core resolvable.
		__setBrowserModuleLoaderForTests(async () => null);
		vi.unstubAllEnvs();
	});

	afterEach(() => {
		__setBrowserModuleLoaderForTests(null);
		vi.unstubAllEnvs();
	});

	it("fails closed when launch reported success but produced no viewerUrl", async () => {
		const dir = await makeRunDir("browser-no-url");
		const launchCtx: LaunchContext = { viewerUrl: null };
		const outcome = await __runBrowserCheckForTests(
			dir,
			{},
			launchCtx,
			new Set(),
		);
		expect(outcome.check.passed).toBe(false);
		expect(outcome.check.kind).toBe("browser");
		expect(outcome.check.diagnostics?.[0]?.severity).toBe("error");
		expect(outcome.check.diagnostics?.[0]?.message).toContain(
			"launch produced no viewerUrl",
		);
		expect(outcome.check.output).toContain("did not surface a viewer URL");
	});

	it("fails closed when puppeteer-core is missing and the optional env var is unset", async () => {
		const dir = await makeRunDir("browser-puppeteer-missing");
		const launchCtx: LaunchContext = {
			viewerUrl: "http://127.0.0.1:65535/",
		};
		const outcome = await __runBrowserCheckForTests(
			dir,
			{},
			launchCtx,
			new Set(),
		);
		expect(outcome.check.passed).toBe(false);
		expect(outcome.check.diagnostics).toBeDefined();
		expect(outcome.check.diagnostics?.[0]?.message).toContain(
			"puppeteer-core dependency missing",
		);
		expect(outcome.check.output).toContain("MILADY_BROWSER_VERIFY_OPTIONAL=1");
		expect(outcome.check.output).toContain("bun add -D puppeteer-core");
	});

	it("soft-skips when puppeteer-core is missing and MILADY_BROWSER_VERIFY_OPTIONAL=1", async () => {
		vi.stubEnv("MILADY_BROWSER_VERIFY_OPTIONAL", "1");
		const dir = await makeRunDir("browser-puppeteer-optional");
		const launchCtx: LaunchContext = {
			viewerUrl: "http://127.0.0.1:65535/",
		};
		const outcome = await __runBrowserCheckForTests(
			dir,
			{},
			launchCtx,
			new Set(),
		);
		expect(outcome.check.passed).toBe(true);
		expect(outcome.check.diagnostics).toBeUndefined();
		expect(outcome.check.output).toContain("MILADY_BROWSER_VERIFY_OPTIONAL=1");
		expect(outcome.check.output).toContain("install puppeteer-core");
	});

	it("rethrows non-MODULE_NOT_FOUND errors from the loader (no silent swallow)", async () => {
		__setBrowserModuleLoaderForTests(async () => {
			throw new Error(
				"[AppVerificationService] failed to load puppeteer-core: simulated init crash",
			);
		});
		const dir = await makeRunDir("browser-loader-throws");
		const launchCtx: LaunchContext = {
			viewerUrl: "http://127.0.0.1:65535/",
		};
		await expect(
			__runBrowserCheckForTests(dir, {}, launchCtx, new Set()),
		).rejects.toThrow(/failed to load puppeteer-core/);
	});
});

/**
 * @module plugin-app-control/__tests__/protected-apps.test
 *
 * Covers `resolveProtectedApps` / `isProtected`:
 *   - env-only contribution
 *   - first-party-dir-only contribution (synthetic `eliza/apps/`)
 *   - both contributions deduped into the same set
 *   - lookups match scoped, basename, and `app-` suffix forms
 *   - missing `eliza/apps/` returns empty array (no throw)
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isProtected,
	type ProtectedAppsResolution,
	resolveProtectedApps,
} from "../protected-apps.js";

let repoRoot: string;
let originalEnv: string | undefined;

beforeEach(async () => {
	repoRoot = await mkdtemp(path.join(tmpdir(), "milady-protected-apps-"));
	originalEnv = process.env.MILADY_PROTECTED_APPS;
	delete process.env.MILADY_PROTECTED_APPS;
});

afterEach(async () => {
	if (originalEnv === undefined) {
		delete process.env.MILADY_PROTECTED_APPS;
	} else {
		process.env.MILADY_PROTECTED_APPS = originalEnv;
	}
	await rm(repoRoot, { recursive: true, force: true });
});

async function makeApp(name: string): Promise<void> {
	const dir = path.join(repoRoot, "eliza", "apps", name);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, "package.json"), "{}", "utf8");
}

describe("resolveProtectedApps", () => {
	it("returns empty contributions when env is unset and eliza/apps/ is absent", async () => {
		const resolution = await resolveProtectedApps(repoRoot);
		expect(resolution.fromEnv).toEqual([]);
		expect(resolution.fromFirstPartyDir).toEqual([]);
		expect(resolution.set.size).toBe(0);
	});

	it("returns env-only contributions when only the env var is set", async () => {
		process.env.MILADY_PROTECTED_APPS =
			"@elizaos/app-companion , custom-locked,  ";
		const resolution = await resolveProtectedApps(repoRoot);
		expect(resolution.fromEnv).toEqual([
			"@elizaos/app-companion",
			"custom-locked",
		]);
		expect(resolution.fromFirstPartyDir).toEqual([]);
		// Scoped name expands to scoped + basename + suffix.
		expect(resolution.set.has("@elizaos/app-companion")).toBe(true);
		expect(resolution.set.has("app-companion")).toBe(true);
		expect(resolution.set.has("companion")).toBe(true);
		expect(resolution.set.has("custom-locked")).toBe(true);
	});

	it("returns first-party-only contributions when env is unset but apps exist", async () => {
		await makeApp("app-companion");
		await makeApp("app-shopify");
		await mkdir(path.join(repoRoot, "eliza", "apps", ".cache"), {
			recursive: true,
		});

		const resolution = await resolveProtectedApps(repoRoot);
		expect(resolution.fromEnv).toEqual([]);
		expect(resolution.fromFirstPartyDir.sort()).toEqual([
			"app-companion",
			"app-shopify",
		]);
		// Hidden directories like `.cache` are skipped.
		expect(resolution.set.has(".cache")).toBe(false);

		expect(resolution.set.has("app-companion")).toBe(true);
		expect(resolution.set.has("companion")).toBe(true);
		expect(resolution.set.has("app-shopify")).toBe(true);
		expect(resolution.set.has("shopify")).toBe(true);
	});

	it("unions env + first-party contributions and dedupes", async () => {
		await makeApp("app-companion");
		await makeApp("app-training");
		process.env.MILADY_PROTECTED_APPS = "app-companion,custom-locked";

		const resolution = await resolveProtectedApps(repoRoot);
		expect(resolution.fromEnv).toEqual(["app-companion", "custom-locked"]);
		expect(resolution.fromFirstPartyDir.sort()).toEqual([
			"app-companion",
			"app-training",
		]);

		// Same name from both sources yields a single canonical set entry.
		const expected = [
			"app-companion",
			"companion",
			"app-training",
			"training",
			"custom-locked",
		];
		for (const form of expected) {
			expect(resolution.set.has(form)).toBe(true);
		}
	});
});

describe("isProtected", () => {
	let resolution: ProtectedAppsResolution;

	beforeEach(async () => {
		await makeApp("app-companion");
		process.env.MILADY_PROTECTED_APPS = "@elizaos/app-shopify,custom-locked";
		resolution = await resolveProtectedApps(repoRoot);
	});

	it("matches the canonical scoped form", () => {
		expect(isProtected("@elizaos/app-shopify", resolution)).toBe(true);
	});

	it("matches the package basename of a scoped name", () => {
		expect(isProtected("app-shopify", resolution)).toBe(true);
	});

	it("matches the suffix form of an `app-` basename", () => {
		expect(isProtected("shopify", resolution)).toBe(true);
		expect(isProtected("companion", resolution)).toBe(true);
	});

	it("matches a non-`app-`-prefixed env entry as-is", () => {
		expect(isProtected("custom-locked", resolution)).toBe(true);
	});

	it("matches a foreign-scoped package whose basename collides", () => {
		// A malicious `@evil/app-companion` collides on the basename
		// derived from the first-party `eliza/apps/app-companion`.
		expect(isProtected("@evil/app-companion", resolution)).toBe(true);
	});

	it("is case-insensitive", () => {
		expect(isProtected("APP-COMPANION", resolution)).toBe(true);
		expect(isProtected("@ElizaOS/App-Shopify", resolution)).toBe(true);
	});

	it("returns false for unrelated names", () => {
		expect(isProtected("@me/app-foo", resolution)).toBe(false);
		expect(isProtected("foo", resolution)).toBe(false);
		expect(isProtected("", resolution)).toBe(false);
	});
});

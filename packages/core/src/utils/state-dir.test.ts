import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import { __resetReadEnvWarnings } from "./read-env.ts";
import {
	getElizaNamespace,
	migrateLegacyStateDir,
	migrateStateDir,
	resolveOAuthDir,
	resolveStateDir,
	resolveUserPath,
} from "./state-dir.ts";

const FAKE_HOME = "/fake/home";
const fakeHomedir = () => FAKE_HOME;

describe("resolveStateDir", () => {
	beforeEach(() => __resetReadEnvWarnings());

	it("honors ELIZA_STATE_DIR over the legacy MILADY_STATE_DIR", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(
			resolveStateDir(
				{
					MILADY_STATE_DIR: "/tmp/legacy",
					ELIZA_STATE_DIR: "/tmp/canonical",
				},
				fakeHomedir,
			),
		).toBe("/tmp/canonical");
		// Canonical wins → legacy alias never consulted → no deprecation warning.
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it("still honors the legacy MILADY_STATE_DIR (with a one-time deprecation warning)", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect(
			resolveStateDir({ MILADY_STATE_DIR: "/tmp/legacy" }, fakeHomedir),
		).toBe("/tmp/legacy");
		// And a second read does not re-warn.
		resolveStateDir({ MILADY_STATE_DIR: "/tmp/legacy" }, fakeHomedir);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain("MILADY_STATE_DIR");
		warn.mockRestore();
	});

	it("derives ~/.<namespace> from ELIZA_NAMESPACE when no override is set", () => {
		expect(resolveStateDir({ ELIZA_NAMESPACE: "custom" }, fakeHomedir)).toBe(
			join(FAKE_HOME, ".custom"),
		);
	});

	it("defaults the namespace to 'eliza' when nothing is set", () => {
		expect(resolveStateDir({}, fakeHomedir)).toBe(join(FAKE_HOME, ".eliza"));
	});

	it("treats whitespace-only env values as unset", () => {
		expect(
			resolveStateDir(
				{ ELIZA_STATE_DIR: "   ", MILADY_STATE_DIR: "/tmp/bar" },
				fakeHomedir,
			),
		).toBe("/tmp/bar");
	});

	it("expands a leading ~ in env overrides via the real homedir", () => {
		const result = resolveStateDir({ ELIZA_STATE_DIR: "~/custom" });
		expect(result.endsWith("/custom")).toBe(true);
		expect(result.startsWith("/")).toBe(true);
	});
});

describe("getElizaNamespace", () => {
	it("returns 'eliza' by default", () => {
		expect(getElizaNamespace({})).toBe("eliza");
	});

	it("returns the override when ELIZA_NAMESPACE is set", () => {
		expect(getElizaNamespace({ ELIZA_NAMESPACE: "custom" })).toBe("custom");
	});
});

describe("resolveOAuthDir", () => {
	it("defaults to <state-dir>/credentials", () => {
		expect(resolveOAuthDir({ ELIZA_STATE_DIR: "/tmp/foo" })).toBe(
			"/tmp/foo/credentials",
		);
	});

	it("honors ELIZA_OAUTH_DIR override", () => {
		expect(
			resolveOAuthDir({
				ELIZA_STATE_DIR: "/tmp/foo",
				ELIZA_OAUTH_DIR: "/tmp/oauth-elsewhere",
			}),
		).toBe("/tmp/oauth-elsewhere");
	});
});

describe("resolveUserPath", () => {
	it("returns an empty string for empty input", () => {
		expect(resolveUserPath("")).toBe("");
	});

	it("expands a leading ~", () => {
		const result = resolveUserPath("~/foo");
		expect(result.endsWith("/foo")).toBe(true);
		expect(result.startsWith("/")).toBe(true);
	});

	it("resolves a relative path to absolute", () => {
		expect(resolveUserPath("relative")).toBe(join(process.cwd(), "relative"));
	});
});

describe("migrateLegacyStateDir", () => {
	let tempHome: string;

	beforeEach(async () => {
		tempHome = await mkdtemp(join(tmpdir(), "legacy-state-home-"));
		__resetReadEnvWarnings();
	});

	afterEach(async () => {
		const { rm } = await import("node:fs/promises");
		try {
			await rm(tempHome, { recursive: true, force: true });
		} catch {}
	});

	const getHome = () => tempHome;

	it("no-ops when an explicit ELIZA_STATE_DIR is set", () => {
		expect(
			migrateLegacyStateDir({ ELIZA_STATE_DIR: "/tmp/x" }, getHome),
		).toEqual({ migrated: false });
	});

	it("no-ops when an explicit (legacy) MILADY_STATE_DIR is set", () => {
		expect(
			migrateLegacyStateDir({ MILADY_STATE_DIR: "/tmp/x" }, getHome),
		).toEqual({ migrated: false });
	});

	it("no-ops when ~/.eliza already exists", async () => {
		await mkdir(join(tempHome, ".eliza"), { recursive: true });
		await mkdir(join(tempHome, ".milady"), { recursive: true });
		expect(migrateLegacyStateDir({}, getHome)).toEqual({ migrated: false });
	});

	it("no-ops when ~/.milady does not exist", () => {
		expect(migrateLegacyStateDir({}, getHome)).toEqual({ migrated: false });
	});

	it("migrates ~/.milady → ~/.eliza on first run and logs once", async () => {
		const legacyDir = join(tempHome, ".milady");
		await mkdir(join(legacyDir, "skills"), { recursive: true });
		await writeFile(join(legacyDir, "milady.json"), '{"a":1}');
		await writeFile(join(legacyDir, "skills", "x.md"), "skill");

		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const result = migrateLegacyStateDir({}, getHome);
		expect(result.migrated).toBe(true);
		expect(result.from).toBe(legacyDir);
		expect(result.to).toBe(join(tempHome, ".eliza"));
		expect(existsSync(join(tempHome, ".eliza", "milady.json"))).toBe(true);
		expect(readFileSync(join(tempHome, ".eliza", "skills", "x.md"), "utf8")).toBe(
			"skill",
		);
		// Legacy dir left in place.
		expect(existsSync(legacyDir)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		warn.mockRestore();
	});
});

describe("migrateStateDir", () => {
	let tempRoot: string;

	beforeEach(async () => {
		tempRoot = await mkdtemp(join(tmpdir(), "state-dir-migrate-"));
	});

	afterEach(async () => {
		// Best-effort cleanup; ignore failures so a stuck FS doesn't fail the suite
		const { rm } = await import("node:fs/promises");
		try {
			await rm(tempRoot, { recursive: true, force: true });
		} catch {}
	});

	it("returns { migrated: false } when source does not exist", async () => {
		const result = await migrateStateDir(
			join(tempRoot, "missing"),
			join(tempRoot, "dest"),
		);
		expect(result).toEqual({ migrated: false });
	});

	it("returns { migrated: false } when fromPath === toPath", async () => {
		const dir = join(tempRoot, "same");
		await mkdir(dir, { recursive: true });
		const result = await migrateStateDir(dir, dir);
		expect(result).toEqual({ migrated: false });
	});

	it("recursively copies contents and is idempotent", async () => {
		const src = join(tempRoot, "src");
		const dst = join(tempRoot, "dst");
		await mkdir(join(src, "nested"), { recursive: true });
		await writeFile(join(src, "top.txt"), "hello");
		await writeFile(join(src, "nested", "leaf.txt"), "world");

		const first = await migrateStateDir(src, dst);
		expect(first).toEqual({ migrated: true });
		expect(await readFile(join(dst, "top.txt"), "utf8")).toBe("hello");
		expect(await readFile(join(dst, "nested", "leaf.txt"), "utf8")).toBe(
			"world",
		);

		// Idempotent: running again must not throw and must keep contents.
		const second = await migrateStateDir(src, dst);
		expect(second).toEqual({ migrated: true });
		expect(await readFile(join(dst, "top.txt"), "utf8")).toBe("hello");
	});

	it("does not overwrite existing destination files (force: false)", async () => {
		const src = join(tempRoot, "src");
		const dst = join(tempRoot, "dst");
		await mkdir(src, { recursive: true });
		await mkdir(dst, { recursive: true });
		await writeFile(join(src, "f.txt"), "from-src");
		await writeFile(join(dst, "f.txt"), "from-dst");

		await migrateStateDir(src, dst);

		expect(await readFile(join(dst, "f.txt"), "utf8")).toBe("from-dst");
	});
});

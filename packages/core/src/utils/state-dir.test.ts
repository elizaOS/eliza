import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getElizaNamespace,
	migrateStateDir,
	resolveOAuthDir,
	resolveStateDir,
	resolveUserPath,
} from "./state-dir.ts";

const FAKE_HOME = "/fake/home";
const fakeHomedir = () => FAKE_HOME;

describe("resolveStateDir", () => {
	it("honors MILADY_STATE_DIR over ELIZA_STATE_DIR and namespace default", () => {
		expect(
			resolveStateDir(
				{
					MILADY_STATE_DIR: "/tmp/foo",
					ELIZA_STATE_DIR: "/tmp/bar",
					ELIZA_NAMESPACE: "milady",
				},
				fakeHomedir,
			),
		).toBe("/tmp/foo");
	});

	it("honors ELIZA_STATE_DIR when MILADY_STATE_DIR is unset", () => {
		expect(
			resolveStateDir(
				{ ELIZA_STATE_DIR: "/tmp/bar", ELIZA_NAMESPACE: "milady" },
				fakeHomedir,
			),
		).toBe("/tmp/bar");
	});

	it("derives ~/.<namespace> from ELIZA_NAMESPACE when no override is set", () => {
		expect(resolveStateDir({ ELIZA_NAMESPACE: "milady" }, fakeHomedir)).toBe(
			join(FAKE_HOME, ".milady"),
		);
	});

	it("defaults the namespace to 'eliza' when nothing is set", () => {
		expect(resolveStateDir({}, fakeHomedir)).toBe(join(FAKE_HOME, ".eliza"));
	});

	it("treats whitespace-only env values as unset", () => {
		expect(
			resolveStateDir(
				{ MILADY_STATE_DIR: "   ", ELIZA_STATE_DIR: "/tmp/bar" },
				fakeHomedir,
			),
		).toBe("/tmp/bar");
	});

	it("expands a leading ~ in env overrides via the real homedir", () => {
		const result = resolveStateDir({ MILADY_STATE_DIR: "~/custom" });
		expect(result.endsWith("/custom")).toBe(true);
		expect(result.startsWith("/")).toBe(true);
	});
});

describe("getElizaNamespace", () => {
	it("returns 'eliza' by default", () => {
		expect(getElizaNamespace({})).toBe("eliza");
	});

	it("returns the override when ELIZA_NAMESPACE is set", () => {
		expect(getElizaNamespace({ ELIZA_NAMESPACE: "milady" })).toBe("milady");
	});
});

describe("resolveOAuthDir", () => {
	it("defaults to <state-dir>/credentials", () => {
		expect(resolveOAuthDir({ MILADY_STATE_DIR: "/tmp/foo" })).toBe(
			"/tmp/foo/credentials",
		);
	});

	it("honors ELIZA_OAUTH_DIR override", () => {
		expect(
			resolveOAuthDir({
				MILADY_STATE_DIR: "/tmp/foo",
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

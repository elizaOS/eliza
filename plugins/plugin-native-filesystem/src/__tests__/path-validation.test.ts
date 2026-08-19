/**
 * Unit tests for `normalizeDevicePath`, plus integration tests exercising the Node
 * backend's traversal/symlink-escape guards against a real temp directory on disk (no mocks).
 */
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { normalizeDevicePath } from "../path.js";
import { DeviceFilesystemBridge } from "../services/device-filesystem-bridge.js";

describe("normalizeDevicePath", () => {
	it("rejects empty paths", () => {
		expect(() => normalizeDevicePath("")).toThrow(/required/);
	});

	it("rejects absolute POSIX paths", () => {
		expect(() => normalizeDevicePath("/etc/passwd")).toThrow(/absolute paths/);
	});

	it("rejects absolute Windows paths", () => {
		expect(() => normalizeDevicePath("C:/secret")).toThrow(/absolute paths/);
		expect(() => normalizeDevicePath("D:\\secret")).toThrow(/absolute paths/);
	});

	it("rejects parent traversal", () => {
		expect(() => normalizeDevicePath("../etc/passwd")).toThrow(/traversal/);
		expect(() => normalizeDevicePath("foo/../../etc/passwd")).toThrow(
			/traversal/,
		);
		expect(() => normalizeDevicePath("foo/..")).toThrow(/traversal/);
	});

	it("rejects NUL bytes", () => {
		expect(() => normalizeDevicePath("foo\0bar")).toThrow(/NUL byte/);
	});

	it("normalizes valid paths into segments", () => {
		expect(normalizeDevicePath("foo/bar.txt")).toEqual({
			relative: "foo/bar.txt",
			segments: ["foo", "bar.txt"],
		});
		expect(normalizeDevicePath("foo\\bar.txt")).toEqual({
			relative: "foo/bar.txt",
			segments: ["foo", "bar.txt"],
		});
		expect(normalizeDevicePath("foo//bar.txt")).toEqual({
			relative: "foo/bar.txt",
			segments: ["foo", "bar.txt"],
		});
	});
});

describe("DeviceFilesystemBridge (Node backend)", () => {
	let tempRoot: string;
	let bridge: DeviceFilesystemBridge;

	beforeEach(() => {
		tempRoot = mkdtempSync(path.join(tmpdir(), "device-fs-"));
		bridge = DeviceFilesystemBridge.forNodeRoot(tempRoot);
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("rejects parent traversal via read", async () => {
		await expect(bridge.read("../escape.txt")).rejects.toThrow(/traversal/);
	});

	it("rejects absolute paths via write", async () => {
		await expect(bridge.write("/abs.txt", "hi")).rejects.toThrow(
			/absolute paths/,
		);
	});

	it("rejects absolute paths via list", async () => {
		await expect(bridge.list("/")).rejects.toThrow(/absolute paths/);
	});

	it("rejects writes whose normalized path would escape root (sanity)", async () => {
		await expect(bridge.write("../../escape.txt", "hi")).rejects.toThrow(
			/traversal/,
		);
	});

	it("round-trips utf8 content", async () => {
		await bridge.write("notes/hello.txt", "héllo");
		const got = await bridge.read("notes/hello.txt");
		expect(got).toBe("héllo");
		const onDisk = await readFile(
			path.join(tempRoot, "notes", "hello.txt"),
			"utf8",
		);
		expect(onDisk).toBe("héllo");
	});

	it("round-trips base64 content", async () => {
		const data = Buffer.from([0, 1, 2, 3, 254, 255]);
		const base64 = data.toString("base64");
		await bridge.write("bin/data.bin", base64, "base64");
		const got = await bridge.read("bin/data.bin", "base64");
		expect(got).toBe(base64);
		const onDisk = await readFile(path.join(tempRoot, "bin", "data.bin"));
		expect(onDisk.equals(data)).toBe(true);
	});

	it("creates missing parent directories on write", async () => {
		await bridge.write("a/b/c/deep.txt", "ok");
		await expect(
			readFile(path.join(tempRoot, "a", "b", "c", "deep.txt"), "utf8"),
		).resolves.toBe("ok");
	});

	it("rejects reading a path that contains a NUL byte", async () => {
		await expect(bridge.read("foo\0bar")).rejects.toThrow(/NUL byte/);
	});

	it("does not let a file pre-seeded outside the root leak in via symlink-ish input", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "device-fs-outside-"));
		try {
			await writeFile(path.join(outside, "secret.txt"), "nope");
			await expect(
				bridge.read(path.relative(tempRoot, path.join(outside, "secret.txt"))),
			).rejects.toThrow();
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects reads through symlinks that resolve outside the root", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "device-fs-outside-"));
		try {
			await writeFile(path.join(outside, "secret.txt"), "nope");
			symlinkSync(outside, path.join(tempRoot, "linked-outside"), "dir");

			await expect(bridge.read("linked-outside/secret.txt")).rejects.toThrow(
				/escapes workspace root/,
			);
			await expect(bridge.list("linked-outside")).rejects.toThrow(
				/escapes workspace root/,
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects writes through symlinked parent directories outside the root", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "device-fs-outside-"));
		try {
			symlinkSync(outside, path.join(tempRoot, "linked-outside"), "dir");

			await expect(
				bridge.write("linked-outside/new.txt", "nope"),
			).rejects.toThrow(/escapes workspace root/);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("does not mkdir missing descendants through a symlink parent outside the root", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "device-fs-outside-"));
		try {
			symlinkSync(outside, path.join(tempRoot, "linked-outside"), "dir");

			await expect(
				bridge.write("linked-outside/nested/new.txt", "nope"),
			).rejects.toThrow(/escapes workspace root/);
			expect(existsSync(path.join(outside, "nested"))).toBe(false);
			expect(existsSync(path.join(outside, "nested", "new.txt"))).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects writes through a symlinked target file pointing outside the root", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "device-fs-outside-"));
		try {
			const victim = path.join(outside, "victim.txt");
			await writeFile(victim, "original");
			// A symlink whose final component escapes the root: the parent dir is
			// inside the workspace, but writeFile() would follow the link and clobber
			// the external file if only the parent were validated.
			symlinkSync(victim, path.join(tempRoot, "link.txt"), "file");

			await expect(
				bridge.write("link.txt", "PWNED-outside-root"),
			).rejects.toThrow(/escapes workspace root/);
			// The guard must fire before writeFile touches the target: the external
			// file is left untouched.
			await expect(readFile(victim, "utf8")).resolves.toBe("original");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects writes through a dangling symlink pointing outside and never creates the external target", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "device-fs-outside-"));
		try {
			const neverCreated = path.join(outside, "never-created.txt");
			// A dangling link: lstat() reports it exists, so the guard runs, but
			// realpath() then throws ENOENT on the missing target. That ENOENT is
			// the only thing closing this create-through-dangling-link escape, so a
			// refactor that treats a dangling target as "nonexistent" would reopen it.
			symlinkSync(neverCreated, path.join(tempRoot, "dangling.txt"), "file");

			await expect(
				bridge.write("dangling.txt", "PWNED-outside-root"),
			).rejects.toThrow();
			// The write must fail closed: the external path stays uncreated.
			expect(existsSync(neverCreated)).toBe(false);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("rejects writes through a two-hop symlink chain escaping the root", async () => {
		const outside = mkdtempSync(path.join(tmpdir(), "device-fs-outside-"));
		try {
			const victim = path.join(outside, "victim.txt");
			await writeFile(victim, "original");
			// hop-b lives outside and points at the victim; hop-a lives inside the
			// root and points at hop-b. realpath() must resolve the whole chain and
			// reject on the escaped final target.
			const hopB = path.join(outside, "hop-b.txt");
			symlinkSync(victim, hopB, "file");
			symlinkSync(hopB, path.join(tempRoot, "hop-a.txt"), "file");

			await expect(
				bridge.write("hop-a.txt", "PWNED-outside-root"),
			).rejects.toThrow(/escapes workspace root/);
			await expect(readFile(victim, "utf8")).resolves.toBe("original");
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("follows an in-root symlink to an in-root file on write (read/write symmetry)", async () => {
		await bridge.write("notes/target.txt", "v1");
		symlinkSync(
			path.join(tempRoot, "notes", "target.txt"),
			path.join(tempRoot, "link-to-target.txt"),
			"file",
		);

		// The link and its target both resolve inside the root, so the guard must
		// allow the write and follow the link — mirroring read()/list() behavior.
		await bridge.write("link-to-target.txt", "v2");
		const onDisk = await readFile(
			path.join(tempRoot, "notes", "target.txt"),
			"utf8",
		);
		expect(onDisk).toBe("v2");
	});

	it("overwrites an ordinary existing in-root file without tripping the guard", async () => {
		await bridge.write("notes/keep.txt", "v1");
		await bridge.write("notes/keep.txt", "v2");
		const onDisk = await readFile(
			path.join(tempRoot, "notes", "keep.txt"),
			"utf8",
		);
		expect(onDisk).toBe("v2");
	});
});

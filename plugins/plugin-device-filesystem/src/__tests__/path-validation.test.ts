import { mkdtempSync, rmSync } from "node:fs";
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
    expect(() => normalizeDevicePath("/etc/passwd")).toThrow(
      /absolute paths/,
    );
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
});

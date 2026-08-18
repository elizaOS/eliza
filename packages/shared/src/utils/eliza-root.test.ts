/**
 * Tests for elizaOS package root resolution in resolveElizaPackageRoot and
 * resolveElizaPackageRootSync.
 */
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveElizaPackageRoot,
  resolveElizaPackageRootSync,
} from "./eliza-root.ts";

describe("resolveElizaPackageRoot", () => {
  it("resolves the root package directory when given cwd", async () => {
    const cwd = process.cwd();
    const resolved = await resolveElizaPackageRoot({ cwd });
    expect(resolved).toBeTruthy();
    expect(typeof resolved).toBe("string");
  });

  it("resolves the root package directory when given moduleUrl", async () => {
    const moduleUrl = import.meta.url;
    const resolved = await resolveElizaPackageRoot({ moduleUrl });
    expect(resolved).toBeTruthy();
    expect(typeof resolved).toBe("string");
  });

  it("resolves the root package directory when given argv1", async () => {
    const argv1 = path.join(process.cwd(), "packages/shared/src/index.ts");
    const resolved = await resolveElizaPackageRoot({ argv1 });
    expect(resolved).toBeTruthy();
    expect(typeof resolved).toBe("string");
  });

  it("resolves from node_modules .bin argv1 candidate path", async () => {
    const fakeBin = path.join(
      process.cwd(),
      "node_modules",
      ".bin",
      "eliza-cli",
    );
    const resolved = await resolveElizaPackageRoot({ argv1: fakeBin });
    expect(resolved).toBeTruthy();
  });

  it("returns null when no candidate matches the eliza package root", async () => {
    const resolved = await resolveElizaPackageRoot({
      cwd: path.parse(process.cwd()).root,
    });
    expect(resolved).toBeNull();
  });

  it("handles nullish, empty, or malformed options safely", async () => {
    expect(await resolveElizaPackageRoot({})).toBeNull();
    expect(
      await resolveElizaPackageRoot(null as unknown as { cwd?: string }),
    ).toBeNull();
    expect(
      await resolveElizaPackageRoot(undefined as unknown as { cwd?: string }),
    ).toBeNull();
    expect(
      await resolveElizaPackageRoot({
        moduleUrl: "invalid-url",
        argv1: "",
        cwd: "   ",
      }),
    ).toBeNull();
  });
});

describe("resolveElizaPackageRootSync", () => {
  it("resolves the root package directory synchronously when given cwd", () => {
    const cwd = process.cwd();
    const resolved = resolveElizaPackageRootSync({ cwd });
    expect(resolved).toBeTruthy();
    expect(typeof resolved).toBe("string");
  });

  it("resolves the root package directory synchronously when given moduleUrl", () => {
    const moduleUrl = import.meta.url;
    const resolved = resolveElizaPackageRootSync({ moduleUrl });
    expect(resolved).toBeTruthy();
    expect(typeof resolved).toBe("string");
  });

  it("returns null when no candidate matches in synchronous resolution", () => {
    const resolved = resolveElizaPackageRootSync({
      cwd: path.parse(process.cwd()).root,
    });
    expect(resolved).toBeNull();
  });

  it("matches async result for identical options", async () => {
    const opts = { moduleUrl: import.meta.url, cwd: process.cwd() };
    const asyncResult = await resolveElizaPackageRoot(opts);
    const syncResult = resolveElizaPackageRootSync(opts);
    expect(asyncResult).toBe(syncResult);
  });
});

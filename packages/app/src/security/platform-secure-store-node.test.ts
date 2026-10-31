/**
 * `resolveBundledKeyringPath` is the packaged-runtime fallback used when the
 * primary `@napi-rs/keyring` import path fails (see `importNativeKeyring`).
 * It must distinguish "no bundled binding is packaged" (a legitimate absence)
 * from "the runtime directory exists but cannot be read" (a broken install).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledKeyringPath } from "./platform-secure-store-node.ts";

const created: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-keyring-path-"));
  created.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("resolveBundledKeyringPath", () => {
  it("resolves the single packaged binding next to the entrypoint", () => {
    const runtimeDir = makeTempDir();
    const binding = path.join(runtimeDir, "keyring.darwin-arm64.node");
    fs.writeFileSync(binding, "");

    expect(
      resolveBundledKeyringPath({
        arch: "arm64",
        entrypoint: path.join(runtimeDir, "index.js"),
        platform: "darwin",
      }),
    ).toBe(binding);
  });

  it("reports no binding when the runtime directory does not exist", () => {
    const runtimeDir = makeTempDir();

    expect(
      resolveBundledKeyringPath({
        arch: "arm64",
        entrypoint: path.join(runtimeDir, "missing-runtime", "index.js"),
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("surfaces an unreadable runtime directory instead of reporting no binding", () => {
    const runtimeDir = makeTempDir();
    const runtimePath = path.join(runtimeDir, "runtime");
    // A regular file where the runtime directory should be: readdir fails with
    // ENOTDIR — a broken install, not a missing optional binding.
    fs.writeFileSync(runtimePath, "");

    expect(() =>
      resolveBundledKeyringPath({
        arch: "arm64",
        entrypoint: path.join(runtimePath, "index.js"),
        platform: "darwin",
      }),
    ).toThrow(/ENOTDIR/);
  });
});

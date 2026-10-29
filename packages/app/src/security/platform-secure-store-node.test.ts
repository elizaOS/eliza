/**
 * Covers packaged runtime binding discovery: an absent runtime directory is a
 * supported layout, but an unreadable one is a packaging/permission fault that
 * must not be reported as a missing binding.
 */
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveBundledKeyringPath } from "./platform-secure-store-node";

const directories: string[] = [];

async function newRuntimeDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "keyring-runtime-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("resolveBundledKeyringPath", () => {
  it("returns null when the packaged runtime directory is absent", async () => {
    const directory = await newRuntimeDir();
    expect(
      resolveBundledKeyringPath({
        arch: "arm64",
        entrypoint: path.join(directory, "missing", "index.js"),
        platform: "darwin",
      }),
    ).toBeNull();
  });

  it("returns the single packaged binding for this platform and arch", async () => {
    const directory = await newRuntimeDir();
    const binding = path.join(directory, "keyring.darwin-arm64.node");
    fs.writeFileSync(binding, "");
    expect(
      resolveBundledKeyringPath({
        arch: "arm64",
        entrypoint: path.join(directory, "index.js"),
        platform: "darwin",
      }),
    ).toBe(binding);
  });

  it("surfaces an unreadable runtime directory instead of a missing binding", async () => {
    // chmod cannot deny root, so the fault cannot be reproduced there.
    if (process.getuid?.() === 0) return;
    const directory = await newRuntimeDir();
    fs.writeFileSync(path.join(directory, "keyring.darwin-arm64.node"), "");
    fs.chmodSync(directory, 0o000);
    try {
      expect(() =>
        resolveBundledKeyringPath({
          arch: "arm64",
          entrypoint: path.join(directory, "index.js"),
          platform: "darwin",
        }),
      ).toThrow(/binding directory could not be read \(EACCES\)/);
    } finally {
      fs.chmodSync(directory, 0o700);
    }
  });
});

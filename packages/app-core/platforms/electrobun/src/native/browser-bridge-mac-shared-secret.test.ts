/** Exercises atomic Safari App Group secret storage using real temporary files. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadMacBrowserBridgeSharedSecret,
  loadOrCreateMacBrowserBridgeSharedSecret,
  resolveMacBrowserBridgeAppGroupContainer,
  resolveMacBrowserBridgeSharedSecretPath,
} from "./browser-bridge-mac-shared-secret";

const roots: string[] = [];

describe("browser bridge macOS shared enrollment secret", () => {
  afterEach(() => {
    for (const root of roots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the canonical App Group container and fixed secret name", () => {
    const container = resolveMacBrowserBridgeAppGroupContainer("/Users/eliza");
    expect(container).toBe(
      "/Users/eliza/Library/Group Containers/group.ai.elizaos.browserbridge",
    );
    expect(resolveMacBrowserBridgeSharedSecretPath(container)).toBe(
      `${container}/s`,
    );
  });

  it("creates, fsyncs, validates, and reuses exactly 32 private bytes", () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "browser-group-"));
    roots.push(container);
    const expected = Buffer.alloc(32, 21);
    expect(
      loadOrCreateMacBrowserBridgeSharedSecret(container, () => expected),
    ).toEqual(expected);
    expect(
      loadOrCreateMacBrowserBridgeSharedSecret(container, () =>
        Buffer.alloc(32, 22),
      ),
    ).toEqual(expected);
    const secretPath = resolveMacBrowserBridgeSharedSecretPath(container);
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
    expect(loadMacBrowserBridgeSharedSecret(container)).toEqual(expected);
  });

  it("rejects symlinked, permissive, and truncated secret files", () => {
    const container = fs.mkdtempSync(path.join(os.tmpdir(), "browser-group-"));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "browser-target-"));
    roots.push(container, target);
    const secretPath = resolveMacBrowserBridgeSharedSecretPath(container);
    const targetFile = path.join(target, "secret");
    fs.writeFileSync(targetFile, Buffer.alloc(32), { mode: 0o600 });
    fs.symlinkSync(targetFile, secretPath);
    expect(() => loadMacBrowserBridgeSharedSecret(container)).toThrow();
    fs.unlinkSync(secretPath);
    fs.writeFileSync(secretPath, Buffer.alloc(32), { mode: 0o644 });
    expect(() => loadMacBrowserBridgeSharedSecret(container)).toThrow(
      "private regular file",
    );
    fs.chmodSync(secretPath, 0o600);
    fs.writeFileSync(secretPath, Buffer.alloc(31));
    expect(() => loadMacBrowserBridgeSharedSecret(container)).toThrow(
      "invalid length",
    );
  });

  it("rejects a symlinked or wrong-owner container", () => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), "browser-group-real-"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-group-link-"));
    roots.push(real, root);
    const link = path.join(root, "container");
    fs.symlinkSync(real, link);
    expect(() => loadOrCreateMacBrowserBridgeSharedSecret(link)).toThrow(
      "real directory",
    );
    expect(() =>
      loadOrCreateMacBrowserBridgeSharedSecret(
        real,
        () => Buffer.alloc(32),
        (process.getuid?.() ?? 501) + 1,
      ),
    ).toThrow("wrong owner");
  });
});

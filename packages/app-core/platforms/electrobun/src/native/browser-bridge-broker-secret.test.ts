/** Exercises broker-secret creation, reuse, and permission validation in temporary state roots. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadBrowserBridgeBrokerSecret,
  loadOrCreateBrowserBridgeBrokerSecret,
  resolveBrowserBridgeBrokerSecretPath,
} from "./browser-bridge-broker-secret";

const roots: string[] = [];

describe("browser bridge broker secret", () => {
  afterEach(() => {
    for (const root of roots.splice(0))
      fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates and reuses exactly 32 private bytes", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "browser-secret-"));
    roots.push(stateDir);
    const env = { ELIZA_STATE_DIR: stateDir };
    const expected = Buffer.alloc(32, 11);
    expect(loadOrCreateBrowserBridgeBrokerSecret(env, () => expected)).toEqual(
      expected,
    );
    expect(
      loadOrCreateBrowserBridgeBrokerSecret(env, () => Buffer.alloc(32, 12)),
    ).toEqual(expected);
    const secretPath = resolveBrowserBridgeBrokerSecretPath(env);
    expect(fs.statSync(secretPath).mode & 0o777).toBe(0o600);
  });

  it("rejects permissive or malformed secret files", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-secret-bad-"),
    );
    roots.push(stateDir);
    const env = { ELIZA_STATE_DIR: stateDir };
    const secretPath = resolveBrowserBridgeBrokerSecretPath(env);
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretPath, Buffer.alloc(31), { mode: 0o600 });
    expect(() => loadBrowserBridgeBrokerSecret(env)).toThrow("invalid length");
    fs.writeFileSync(secretPath, Buffer.alloc(32), { mode: 0o600 });
    fs.chmodSync(secretPath, 0o644);
    expect(() => loadBrowserBridgeBrokerSecret(env)).toThrow("mode-0600");
  });

  it("rejects symlinked, permissive, or wrong-owner secret directories", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-secret-dir-"),
    );
    const target = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-secret-target-"),
    );
    roots.push(stateDir, target);
    const env = { ELIZA_STATE_DIR: stateDir };
    const directory = path.dirname(resolveBrowserBridgeBrokerSecretPath(env));
    fs.symlinkSync(target, directory);
    expect(() => loadOrCreateBrowserBridgeBrokerSecret(env)).toThrow(
      "real mode-0700 directory",
    );
    fs.unlinkSync(directory);
    fs.mkdirSync(directory, { mode: 0o755 });
    expect(() => loadOrCreateBrowserBridgeBrokerSecret(env)).toThrow(
      "real mode-0700 directory",
    );
    fs.chmodSync(directory, 0o700);
    const currentUid = process.getuid?.() ?? 501;
    expect(() =>
      loadOrCreateBrowserBridgeBrokerSecret(
        env,
        () => Buffer.alloc(32, 1),
        currentUid + 1,
      ),
    ).toThrow("not owned by the current user");
  });
});

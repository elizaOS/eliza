/** Exercises broker-secret creation, reuse, and permission validation in temporary state roots. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadBrowserBridgeBrokerSecret,
  loadOrCreateBrowserBridgeBrokerSecret,
  resolveBrowserBridgeBrokerSecretPath,
  windowsBrowserBridgeSecretInvocation,
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
    expect(() => loadOrCreateBrowserBridgeBrokerSecret(env)).toThrow("symlink");
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

  it("rejects symlink traversal above the private secret directory", () => {
    const realStateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-secret-real-"),
    );
    const linkRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-secret-link-"),
    );
    roots.push(realStateDir, linkRoot);
    const stateLink = path.join(linkRoot, "state");
    fs.symlinkSync(realStateDir, stateLink);
    expect(() =>
      loadOrCreateBrowserBridgeBrokerSecret(
        { ELIZA_STATE_DIR: stateLink },
        () => Buffer.alloc(32, 1),
      ),
    ).toThrow("traverses a symlink");
  });

  it("rejects a secret replaced between validation and descriptor open", () => {
    const stateDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "browser-secret-race-"),
    );
    roots.push(stateDir);
    const env = { ELIZA_STATE_DIR: stateDir };
    loadOrCreateBrowserBridgeBrokerSecret(env, () => Buffer.alloc(32, 1));
    const secretPath = resolveBrowserBridgeBrokerSecretPath(env);
    const originalPath = `${secretPath}.original`;
    const open = fs.openSync.bind(fs);
    let replaced = false;
    const openSpy = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (args[0] === secretPath && !replaced) {
        replaced = true;
        fs.renameSync(secretPath, originalPath);
        fs.writeFileSync(secretPath, Buffer.alloc(32, 2), { mode: 0o600 });
      }
      return open(...args);
    });
    expect(() => loadBrowserBridgeBrokerSecret(env)).toThrow(
      "changed while opening",
    );
    openSpy.mockRestore();
  });

  it("routes Windows secrets through the DPAPI helper without POSIX mode checks", () => {
    const expected = Buffer.alloc(32, 17);
    const calls: Array<{ command: string; args: string[] }> = [];
    expect(
      loadOrCreateBrowserBridgeBrokerSecret(
        { ELIZA_STATE_DIR: "C:\\Users\\alice\\eliza-state" },
        () => Buffer.alloc(32, 99),
        -1,
        {
          platform: "win32",
          windowsHelperPath: "C:\\Eliza\\browser-bridge-secret.ps1",
          runWindowsHelper: (command, args) => {
            calls.push({ command, args });
            return { status: 0, stdout: expected.toString("base64") };
          },
        },
      ),
    ).toEqual(expected);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args).toContain("get-or-create");
  });

  it("builds a fail-closed Windows helper invocation", () => {
    expect(
      windowsBrowserBridgeSecretInvocation(
        "read",
        "C:\\Users\\alice\\broker-secret",
        "C:\\Eliza\\browser-bridge-secret.ps1",
      ),
    ).toEqual({
      command: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        "C:\\Eliza\\browser-bridge-secret.ps1",
        "-Operation",
        "read",
        "-Path",
        "C:\\Users\\alice\\broker-secret",
      ],
    });
    expect(() =>
      windowsBrowserBridgeSecretInvocation(
        "read",
        "C:\\Users\\alice\\broker-secret",
        "relative.ps1",
      ),
    ).toThrow("helper path is invalid");
  });

  it("rejects failed or malformed Windows DPAPI helper output", () => {
    const options = {
      platform: "win32" as const,
      windowsHelperPath: "C:\\Eliza\\browser-bridge-secret.ps1",
    };
    expect(() =>
      loadOrCreateBrowserBridgeBrokerSecret({}, undefined, -1, {
        ...options,
        runWindowsHelper: () => ({ status: 1, stdout: "" }),
      }),
    ).toThrow("helper failed");
    expect(() =>
      loadOrCreateBrowserBridgeBrokerSecret({}, undefined, -1, {
        ...options,
        runWindowsHelper: () => ({
          status: 0,
          stdout: Buffer.alloc(31).toString("base64"),
        }),
      }),
    ).toThrow("invalid length");
  });

  it("uses DPAPI CurrentUser, atomic creation, protected DACLs, and reparse rejection", () => {
    const helper = fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        "../../scripts/browser-bridge-secret.ps1",
      ),
      "utf8",
    );
    expect(helper).toContain("ProtectedData]::Protect");
    expect(helper).toContain("DataProtectionScope]::CurrentUser");
    expect(helper).toContain("RandomNumberGenerator]::Create()");
    expect(helper).toContain("$rng.GetBytes($secret)");
    expect(helper).not.toContain("RandomNumberGenerator]::Fill");
    expect(helper).toContain("FileMode]::CreateNew");
    expect(helper).toContain(
      "Directory]::CreateDirectory($directory, $directoryAcl)",
    );
    expect(helper).toContain("FileSystemRights]::Write");
    expect(helper).toContain("SetAccessRuleProtection($true, $false)");
    expect(helper).toContain("Assert-CurrentUserAcl $directory $true");
    expect(helper).toContain("Assert-CurrentUserAcl $fullPath $false");
    expect(helper).toContain("Get-ChildItem -LiteralPath $parent -Force");
    expect(helper).toContain("FileAttributes]::ReparsePoint");
  });
});

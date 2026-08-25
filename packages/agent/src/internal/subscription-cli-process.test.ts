/**
 * Behavioral coverage for subscription CLI process resolution.
 *
 * Drives the real module against real temp-directory files. PATH, PATHEXT,
 * and platform are passed in; the suite never asserts a mock's own return.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  resolveSubscriptionCliNpmInvocation,
  runSubscriptionCliNpm,
  subscriptionCliCommandAvailable,
} from "./subscription-cli-process.ts";

const fixtureRoot = mkdtempSync(
  path.join(tmpdir(), "subscription-cli-process-"),
);

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function writeFile(filePath: string, contents = "fixture"): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function joinPath(...entries: string[]): string {
  return entries.join(path.delimiter);
}

function windowsNpmLayout(dirName: string): {
  dir: string;
  nodeExe: string;
  npmCli: string;
} {
  const dir = path.join(fixtureRoot, dirName);
  const nodeExe = path.join(dir, "node.exe");
  const npmCli = path.join(dir, "node_modules", "npm", "bin", "npm-cli.js");
  writeFile(nodeExe);
  writeFile(npmCli);
  return { dir, nodeExe, npmCli };
}

describe("subscriptionCliCommandAvailable", () => {
  it("returns false when PATH is empty", () => {
    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: "" },
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("returns false when neither PATH nor Path is set", () => {
    expect(
      subscriptionCliCommandAvailable("codex", {
        env: {},
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("finds a single unix executable by exact filename", () => {
    const binDir = path.join(fixtureRoot, "unix-bin-single");
    writeFile(path.join(binDir, "codex"));

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: binDir },
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("does not treat a same-named directory as an executable", () => {
    const binDir = path.join(fixtureRoot, "unix-bin-dir");
    mkdirSync(path.join(binDir, "codex"), { recursive: true });

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: binDir },
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("does not apply PATHEXT on unix, so a .cmd shim does not satisfy the bare name", () => {
    const binDir = path.join(fixtureRoot, "unix-cmd-only");
    writeFile(path.join(binDir, "codex.cmd"));

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: binDir, PATHEXT: ".CMD;.EXE" },
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("on win32 finds PATHEXT shims and reports a missing command as unavailable", () => {
    const binDir = path.join(fixtureRoot, "win-pathext");
    writeFile(path.join(binDir, "codex.cmd"));

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).toBe(true);
    expect(
      subscriptionCliCommandAvailable("claude", {
        env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("on win32 ignores an extensionless companion file", () => {
    const binDir = path.join(fixtureRoot, "win-extensionless");
    writeFile(path.join(binDir, "codex"), "not-executable-on-windows");

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: binDir, PATHEXT: ".EXE;.CMD" },
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("on win32 uses a command that already has an extension as-is", () => {
    const binDir = path.join(fixtureRoot, "win-explicit-ext");
    writeFile(path.join(binDir, "codex.cmd"));

    expect(
      subscriptionCliCommandAvailable("codex.cmd", {
        env: { PATH: binDir },
        platform: "win32",
      }),
    ).toBe(true);
    expect(
      subscriptionCliCommandAvailable("codex.exe", {
        env: { PATH: binDir },
        platform: "win32",
      }),
    ).toBe(false);
  });

  it("on win32 uses the default PATHEXT list when PATHEXT is unset", () => {
    const binDir = path.join(fixtureRoot, "win-default-pathext");
    writeFile(path.join(binDir, "codex.cmd"));

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: binDir },
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("on win32 skips empty PATHEXT tokens after trim", () => {
    const binDir = path.join(fixtureRoot, "win-empty-pathext-tokens");
    writeFile(path.join(binDir, "codex.cmd"));

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: binDir, PATHEXT: ".EXE;; .CMD ;" },
        platform: "win32",
      }),
    ).toBe(true);
  });

  it("reads Path when PATH is absent", () => {
    const binDir = path.join(fixtureRoot, "path-fallback");
    writeFile(path.join(binDir, "claude"));

    expect(
      subscriptionCliCommandAvailable("claude", {
        env: { Path: binDir },
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("strips quotes and trims PATH entries", () => {
    const binDir = path.join(fixtureRoot, "quoted path dir");
    writeFile(path.join(binDir, "codex"));

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: `  "${binDir}"  ` },
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("walks PATH in order and finds the command in a later directory", () => {
    const emptyDir = path.join(fixtureRoot, "path-order-empty");
    const laterDir = path.join(fixtureRoot, "path-order-later");
    mkdirSync(emptyDir, { recursive: true });
    writeFile(path.join(laterDir, "codex"));

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: joinPath(emptyDir, laterDir) },
        platform: "linux",
      }),
    ).toBe(true);
  });

  it("filters blank PATH segments", () => {
    const binDir = path.join(fixtureRoot, "blank-segments");
    writeFile(path.join(binDir, "codex"));

    expect(
      subscriptionCliCommandAvailable("codex", {
        env: { PATH: joinPath("", "  ", binDir, "") },
        platform: "linux",
      }),
    ).toBe(true);
  });
});

describe("resolveSubscriptionCliNpmInvocation", () => {
  it("returns npm plus the given args on unix, including an empty argv", () => {
    expect(
      resolveSubscriptionCliNpmInvocation(["install", "pkg"], {
        platform: "linux",
      }),
    ).toEqual({ command: "npm", args: ["install", "pkg"] });
    expect(
      resolveSubscriptionCliNpmInvocation([], { platform: "darwin" }),
    ).toEqual({ command: "npm", args: [] });
  });

  it("preserves argv with spaces and shell metacharacters as ordinary data", () => {
    const args = ["install", "--prefix", "C:\\Users\\name with spaces\\&tools"];
    expect(
      resolveSubscriptionCliNpmInvocation(args, { platform: "linux" }),
    ).toEqual({ command: "npm", args });
  });

  it("on win32 uses the first complete node.exe + npm-cli.js layout", () => {
    const first = windowsNpmLayout("win-first-complete");
    const second = windowsNpmLayout("win-second-complete");

    expect(
      resolveSubscriptionCliNpmInvocation(["install", "pkg"], {
        env: { PATH: joinPath(first.dir, second.dir) },
        platform: "win32",
      }),
    ).toEqual({
      command: first.nodeExe,
      args: [first.npmCli, "install", "pkg"],
    });
  });

  it("on win32 skips an incomplete layout and uses a later complete one", () => {
    const incomplete = path.join(fixtureRoot, "incomplete node");
    writeFile(path.join(incomplete, "node.exe"));
    const complete = windowsNpmLayout("complete node");

    expect(
      resolveSubscriptionCliNpmInvocation(["install", "pkg"], {
        env: {
          PATH: joinPath(`"${incomplete}"`, `"${complete.dir}"`),
        },
        platform: "win32",
      }),
    ).toEqual({
      command: complete.nodeExe,
      args: [complete.npmCli, "install", "pkg"],
    });
  });

  it("on win32 throws when PATH is empty", () => {
    expect(() =>
      resolveSubscriptionCliNpmInvocation(["install"], {
        env: { PATH: "" },
        platform: "win32",
      }),
    ).toThrow("No complete Windows Node.js/npm installation was found on PATH");
  });

  it("on win32 throws when only node.exe exists", () => {
    const dir = path.join(fixtureRoot, "node-only");
    writeFile(path.join(dir, "node.exe"));

    expect(() =>
      resolveSubscriptionCliNpmInvocation(["install"], {
        env: { PATH: dir },
        platform: "win32",
      }),
    ).toThrow("No complete Windows Node.js/npm installation was found on PATH");
  });

  it("on win32 throws when only npm-cli.js exists", () => {
    const dir = path.join(fixtureRoot, "npm-cli-only");
    writeFile(path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"));

    expect(() =>
      resolveSubscriptionCliNpmInvocation(["install"], {
        env: { PATH: dir },
        platform: "win32",
      }),
    ).toThrow("No complete Windows Node.js/npm installation was found on PATH");
  });

  it("on win32 skips a duplicate PATH entry of the same directory", () => {
    const install = windowsNpmLayout("win-duplicate-path");

    expect(
      resolveSubscriptionCliNpmInvocation(["-v"], {
        env: { PATH: joinPath(install.dir, install.dir) },
        platform: "win32",
      }),
    ).toEqual({
      command: install.nodeExe,
      args: [install.npmCli, "-v"],
    });
  });

  it("on win32 skips a case-variant duplicate PATH entry", () => {
    const install = windowsNpmLayout("Win-Case-Dup");

    expect(
      resolveSubscriptionCliNpmInvocation(["-v"], {
        env: { PATH: joinPath(install.dir, install.dir.toUpperCase()) },
        platform: "win32",
      }),
    ).toEqual({
      command: install.nodeExe,
      args: [install.npmCli, "-v"],
    });
  });
});

describe("runSubscriptionCliNpm", () => {
  it("on unix calls execute with npm, the given args, and timeout, and returns its result", async () => {
    const args = ["install", "pkg"];
    const calls: Array<{
      command: string;
      args: string[];
      options: { timeout: number };
    }> = [];

    const result = await runSubscriptionCliNpm(args, {
      platform: "linux",
      timeout: 4321,
      execute: async (command, commandArgs, options) => {
        calls.push({ command, args: commandArgs, options });
        return { stdout: "installed" };
      },
    });

    expect(calls).toEqual([
      { command: "npm", args, options: { timeout: 4321 } },
    ]);
    expect(result).toEqual({ stdout: "installed" });
    expect(args).toEqual(["install", "pkg"]);
  });

  it("on win32 calls execute with node.exe and prepended npm-cli.js argv", async () => {
    const install = windowsNpmLayout("win-run-complete");
    const args = ["install", "--prefix", "C:\\Users\\name & tools"];
    const calls: Array<{
      command: string;
      args: string[];
      options: { timeout: number };
    }> = [];

    await runSubscriptionCliNpm(args, {
      env: { PATH: install.dir },
      platform: "win32",
      timeout: 1234,
      execute: async (command, commandArgs, options) => {
        calls.push({ command, args: commandArgs, options });
        return undefined;
      },
    });

    expect(calls).toEqual([
      {
        command: install.nodeExe,
        args: [install.npmCli, ...args],
        options: { timeout: 1234 },
      },
    ]);
    expect(args).toEqual(["install", "--prefix", "C:\\Users\\name & tools"]);
  });

  it("propagates execute rejection", async () => {
    await expect(
      runSubscriptionCliNpm(["install"], {
        platform: "linux",
        timeout: 1000,
        execute: async () => {
          throw new Error("npm exploded");
        },
      }),
    ).rejects.toThrow("npm exploded");
  });

  it("on win32 fails before execute when no complete install exists", async () => {
    let executed = false;

    await expect(
      runSubscriptionCliNpm(["install"], {
        env: { PATH: path.join(fixtureRoot, "missing-win-node") },
        platform: "win32",
        timeout: 1000,
        execute: async () => {
          executed = true;
          return undefined;
        },
      }),
    ).rejects.toThrow(
      "No complete Windows Node.js/npm installation was found on PATH",
    );
    expect(executed).toBe(false);
  });
});

/**
 * `ensureSubscriptionCli` (#16518): the device-login CLI bootstrap must work
 * for a NON-ROOT service user — a user-prefix npm install under the eliza
 * state dir (never `-g`, never /usr/lib/node_modules, `--ignore-scripts` so
 * package lifecycle scripts never execute), a structured
 * prerequisite error when installation is impossible, no guaranteed-to-fail
 * reinstall on every OAuth attempt (cooldown-cached failure), and the tools
 * bin dir made visible to the later CLI launch.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resolveSubscriptionCliNpmInvocation,
  runSubscriptionCliNpm,
  subscriptionCliCommandAvailable,
} from "../internal/subscription-cli-process.ts";
import {
  __clearSubscriptionCliInstallFailures,
  ensureSubscriptionCli,
} from "./accounts-routes";

const stateDir = mkdtempSync(path.join(tmpdir(), "eliza-state-"));
const prevStateDir = process.env.ELIZA_STATE_DIR;
const prevPath = process.env.PATH;
process.env.ELIZA_STATE_DIR = stateDir;

const expectedPrefix = path.join(stateDir, "tools", "subscription-cli");
const expectedBinDir = path.join(expectedPrefix, "node_modules", ".bin");

beforeEach(() => {
  __clearSubscriptionCliInstallFailures();
  process.env.PATH = prevPath;
});

afterAll(() => {
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  process.env.PATH = prevPath;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("ensureSubscriptionCli (#16518)", () => {
  it("installs into the user-writable state-dir prefix, never -g", async () => {
    const installs: string[][] = [];
    let installed = false;
    await ensureSubscriptionCli("anthropic-subscription", {
      isAvailable: async () => installed,
      runInstall: async (args) => {
        installs.push(args);
        installed = true;
      },
    });

    expect(installs).toHaveLength(1);
    expect(installs[0]).toEqual([
      "install",
      "--prefix",
      expectedPrefix,
      "--ignore-scripts",
      "--no-fund",
      "--no-audit",
      "@anthropic-ai/claude-code",
    ]);
    expect(installs[0]).not.toContain("-g");
  });

  it("deduplicates concurrent bootstrap attempts into one install", async () => {
    let installs = 0;
    let installed = false;
    let releaseInstall: (() => void) | undefined;
    let notifyInstallStarted: (() => void) | undefined;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const installStarted = new Promise<void>((resolve) => {
      notifyInstallStarted = resolve;
    });
    const deps = {
      isAvailable: async () => installed,
      runInstall: async () => {
        installs += 1;
        notifyInstallStarted?.();
        await installGate;
        installed = true;
      },
    };

    const first = ensureSubscriptionCli("anthropic-subscription", deps);
    const second = ensureSubscriptionCli("anthropic-subscription", deps);
    await installStarted;
    expect(installs).toBe(1);

    releaseInstall?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(installs).toBe(1);
  });

  it("makes the tools bin dir visible on PATH for the later bare spawn, idempotently", async () => {
    await ensureSubscriptionCli("openai-codex", {
      isAvailable: async () => true,
      runInstall: async () => {
        throw new Error("must not install when available");
      },
    });
    const parts = (process.env.PATH ?? "").split(path.delimiter);
    expect(parts[0]).toBe(expectedBinDir);

    // Second call must not duplicate the entry.
    await ensureSubscriptionCli("openai-codex", {
      isAvailable: async () => true,
    });
    const again = (process.env.PATH ?? "").split(path.delimiter);
    expect(again.filter((p) => p === expectedBinDir)).toHaveLength(1);
  });

  it("a failed install throws a structured prerequisite error with actionable context", async () => {
    const attempt = ensureSubscriptionCli("anthropic-subscription", {
      isAvailable: async () => false,
      runInstall: async () => {
        throw new Error(
          "EACCES: permission denied, mkdir '/usr/lib/node_modules'",
        );
      },
    });
    await expect(attempt).rejects.toBeInstanceOf(ElizaError);
    await attempt.catch((error: ElizaError) => {
      expect(error.code).toBe("SUBSCRIPTION_CLI_INSTALL_FAILED");
      expect(error.context).toMatchObject({
        command: "claude",
        packageName: "@anthropic-ai/claude-code",
        prefix: expectedPrefix,
      });
      expect(String(error.context?.cause)).toContain("EACCES");
    });
  });

  it("does NOT re-run a failed install on the next attempt within the cooldown — and retries after it", async () => {
    let installs = 0;
    let clock = 1_000_000;
    const deps = {
      isAvailable: async () => false,
      runInstall: async () => {
        installs += 1;
        throw new Error("EACCES");
      },
      now: () => clock,
    };

    await expect(ensureSubscriptionCli("openai-codex", deps)).rejects.toThrow(
      "could not be installed",
    );
    expect(installs).toBe(1);

    // Immediate retry (the next OAuth attempt): same structured error, no
    // second guaranteed-to-fail npm run.
    await expect(ensureSubscriptionCli("openai-codex", deps)).rejects.toThrow(
      "could not be installed",
    );
    expect(installs).toBe(1);

    // After the cooldown elapses, a repaired environment gets a fresh attempt.
    clock += 5 * 60 * 1000 + 1;
    await expect(ensureSubscriptionCli("openai-codex", deps)).rejects.toThrow();
    expect(installs).toBe(2);
  });

  it("installed-but-not-on-PATH throws its own structured error", async () => {
    const attempt = ensureSubscriptionCli("openai-codex", {
      isAvailable: async () => false,
      runInstall: async () => undefined,
    });
    await expect(attempt).rejects.toBeInstanceOf(ElizaError);
    await attempt.catch((error: ElizaError) => {
      expect(error.code).toBe("SUBSCRIPTION_CLI_NOT_ON_PATH");
      expect(error.context).toMatchObject({
        command: "codex",
        binDir: expectedBinDir,
      });
    });
  });

  it("a success after a prior failure clears the cached failure", async () => {
    let clock = 1_000_000;
    let works = false;
    let installs = 0;
    const deps = {
      isAvailable: async () => works,
      runInstall: async () => {
        installs += 1;
        if (!works && installs === 1) throw new Error("EACCES");
        works = true;
      },
      now: () => clock,
    };

    await expect(
      ensureSubscriptionCli("anthropic-subscription", deps),
    ).rejects.toThrow();
    clock += 5 * 60 * 1000 + 1;
    await ensureSubscriptionCli("anthropic-subscription", deps);
    expect(installs).toBe(2);

    // The cache is clean: a later missing-CLI state re-installs immediately.
    works = false;
    await expect(
      ensureSubscriptionCli("anthropic-subscription", {
        ...deps,
        runInstall: async () => {
          installs += 1;
          works = true;
        },
      }),
    ).resolves.toBeUndefined();
    expect(installs).toBe(3);
  });
});

describe("subscription CLI Windows process boundary (#21224)", () => {
  it("finds npm-installed .cmd shims using PATHEXT", () => {
    const binDir = path.join(stateDir, "windows-cli-bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, "codex.cmd"), "@echo off\r\n");

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

  it("uses a complete Node/npm layout and skips incomplete PATH entries", () => {
    const incomplete = path.join(stateDir, "incomplete node");
    const complete = path.join(stateDir, "complete node");
    const npmCli = path.join(
      complete,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    mkdirSync(incomplete, { recursive: true });
    mkdirSync(path.dirname(npmCli), { recursive: true });
    writeFileSync(path.join(incomplete, "node.exe"), "fixture");
    writeFileSync(path.join(complete, "node.exe"), "fixture");
    writeFileSync(npmCli, "fixture");

    const invocation = resolveSubscriptionCliNpmInvocation(
      ["install", "package-fixture"],
      {
        env: {
          PATH: `"${incomplete}"${path.delimiter}"${complete}"`,
        },
        platform: "win32",
      },
    );

    expect(invocation).toEqual({
      command: path.join(complete, "node.exe"),
      args: [npmCli, "install", "package-fixture"],
    });
  });

  it("rejects an incomplete Windows npm layout before starting a child", () => {
    const incomplete = path.join(stateDir, "npm-without-node");
    const npmCli = path.join(
      incomplete,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    mkdirSync(path.dirname(npmCli), { recursive: true });
    writeFileSync(npmCli, "fixture");

    expect(() =>
      resolveSubscriptionCliNpmInvocation(["install"], {
        env: { PATH: incomplete },
        platform: "win32",
      }),
    ).toThrow("No complete Windows Node.js/npm installation");
  });

  it("keeps the direct npm command on Unix", () => {
    expect(
      resolveSubscriptionCliNpmInvocation(["install", "package-fixture"], {
        platform: "linux",
      }),
    ).toEqual({
      command: "npm",
      args: ["install", "package-fixture"],
    });
  });

  it("passes the resolved Windows argv and timeout to the executor", async () => {
    const nodeDir = path.join(stateDir, "executable node");
    const npmCli = path.join(
      nodeDir,
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    mkdirSync(path.dirname(npmCli), { recursive: true });
    writeFileSync(path.join(nodeDir, "node.exe"), "fixture");
    writeFileSync(npmCli, "fixture");
    const execute = vi.fn(async () => undefined);

    await runSubscriptionCliNpm(["install", "package-fixture"], {
      env: { PATH: nodeDir },
      execute,
      platform: "win32",
      timeout: 1234,
    });

    expect(execute).toHaveBeenCalledWith(
      path.join(nodeDir, "node.exe"),
      [npmCli, "install", "package-fixture"],
      { timeout: 1234 },
    );
  });
});

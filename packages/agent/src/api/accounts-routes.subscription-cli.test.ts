/**
 * `ensureSubscriptionCli` (#16518): the device-login CLI bootstrap must work
 * for a NON-ROOT service user — a user-prefix npm install under the eliza
 * state dir (never `-g`, never /usr/lib/node_modules), a structured
 * prerequisite error when installation is impossible, no guaranteed-to-fail
 * reinstall on every OAuth attempt (cooldown-cached failure), and the tools
 * bin dir made visible to the later bare `spawn("codex"|"claude")`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
      "--no-fund",
      "--no-audit",
      "@anthropic-ai/claude-code",
    ]);
    expect(installs[0]).not.toContain("-g");
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

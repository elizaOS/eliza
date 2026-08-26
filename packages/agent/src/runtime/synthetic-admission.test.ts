/**
 * Deny-by-default synthetic-mode plugin admission (#24394). Real collector and
 * resolver integration plus a poisoned chat.db regression: the failing #22904
 * negative run booted the production iMessage connector from ambient
 * connector config, so these tests prove that a synthetic process with the
 * same ambient config denies the connector at admission with provenance,
 * persists the denial ledger, fails the boot, and never opens or stats the
 * Messages database path. Deterministic; the poison path is a temp directory
 * and the positive control exercises the real chat.db reader against it.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ElizaError } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ElizaConfig } from "../config/config.ts";
import {
  collectPluginNames,
  type PluginLoadReasons,
} from "./plugin-collector.ts";
import { resolvePlugins } from "./plugin-resolver.ts";
import {
  applySyntheticAdmission,
  assertSyntheticAdmission,
  readSyntheticAdmissionPolicy,
  SYNTHETIC_ALWAYS_ADMITTED_PACKAGES,
  SYNTHETIC_DENIAL_LEDGER_MAX_ENTRIES,
} from "./synthetic-admission.ts";

const ENV_KEYS = [
  "ELIZA_SYNTHETIC_MODE",
  "ELIZA_SYNTHETIC_PLUGIN_ALLOWLIST",
  "ELIZA_STATE_DIR",
  "ELIZA_PLATFORM",
  "ELIZA_LOCAL_LLAMA",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "ELIZA_SKIP_PLUGINS",
] as const;

let savedEnv: Record<string, string | undefined>;
let tempDirs: string[];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  tempDirs = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("readSyntheticAdmissionPolicy", () => {
  it("is inactive without ELIZA_SYNTHETIC_MODE=1", () => {
    expect(readSyntheticAdmissionPolicy().active).toBe(false);
    process.env.ELIZA_SYNTHETIC_MODE = "true";
    expect(readSyntheticAdmissionPolicy().active).toBe(false);
    process.env.ELIZA_SYNTHETIC_MODE = "0";
    expect(readSyntheticAdmissionPolicy().active).toBe(false);
  });

  it("activates with an empty allowlist when the list is unset", () => {
    process.env.ELIZA_SYNTHETIC_MODE = "1";
    const policy = readSyntheticAdmissionPolicy();
    expect(policy.active).toBe(true);
    expect(policy.allowlist.size).toBe(0);
  });

  it("parses and trims declared package names", () => {
    process.env.ELIZA_SYNTHETIC_MODE = "1";
    process.env.ELIZA_SYNTHETIC_PLUGIN_ALLOWLIST =
      " @elizaos/plugin-scheduling , @elizaos/plugin-trajectories ,";
    const policy = readSyntheticAdmissionPolicy();
    expect(policy.allowlist.has("@elizaos/plugin-scheduling")).toBe(true);
    expect(policy.allowlist.has("@elizaos/plugin-trajectories")).toBe(true);
    expect(policy.allowlist.size).toBe(2);
  });

  it("fails closed on entries that are not package names", () => {
    process.env.ELIZA_SYNTHETIC_MODE = "1";
    process.env.ELIZA_SYNTHETIC_PLUGIN_ALLOWLIST =
      "@elizaos/plugin-scheduling,../../../etc/passwd";
    expect(() => readSyntheticAdmissionPolicy()).toThrowError(ElizaError);
    try {
      readSyntheticAdmissionPolicy();
    } catch (error) {
      expect((error as ElizaError).code).toBe("SYNTHETIC_ALLOWLIST_INVALID");
    }
  });
});

describe("applySyntheticAdmission", () => {
  const reasons: PluginLoadReasons = new Map([
    ["@elizaos/plugin-imessage", "connectors.imessage"],
    ["@elizaos/plugin-browser", "CORE_PLUGINS"],
  ]);

  it("passes every package through when the policy is inactive", () => {
    const result = applySyntheticAdmission(
      new Set(["@elizaos/plugin-imessage", "@elizaos/plugin-browser"]),
      reasons,
      { active: false, allowlist: new Set() },
    );
    expect(result.denials).toHaveLength(0);
    expect(result.admitted.size).toBe(2);
  });

  it("denies everything outside the always-admitted set and allowlist, with provenance", () => {
    const result = applySyntheticAdmission(
      new Set([
        "@elizaos/plugin-sql",
        "@elizaos/plugin-imessage",
        "@elizaos/plugin-browser",
        "@elizaos/plugin-scheduling",
      ]),
      reasons,
      { active: true, allowlist: new Set(["@elizaos/plugin-scheduling"]) },
    );
    expect(result.admitted).toEqual(
      new Set(["@elizaos/plugin-sql", "@elizaos/plugin-scheduling"]),
    );
    expect(result.denials).toContainEqual({
      packageName: "@elizaos/plugin-imessage",
      provenance: "connectors.imessage",
    });
    expect(result.denials).toContainEqual({
      packageName: "@elizaos/plugin-browser",
      provenance: "CORE_PLUGINS",
    });
    expect(result.overflowDenialCount).toBe(0);
  });

  it("keeps the always-admitted set minimal and boot-required only", () => {
    expect(SYNTHETIC_ALWAYS_ADMITTED_PACKAGES).toEqual(["@elizaos/plugin-sql"]);
  });

  it("counts denials beyond the ledger cap instead of dropping them silently", () => {
    const oversized = new Set<string>();
    for (let i = 0; i < SYNTHETIC_DENIAL_LEDGER_MAX_ENTRIES + 7; i += 1) {
      oversized.add(`@synthetic-test/plugin-${i}`);
    }
    const result = applySyntheticAdmission(oversized, new Map(), {
      active: true,
      allowlist: new Set(),
    });
    expect(result.denials).toHaveLength(SYNTHETIC_DENIAL_LEDGER_MAX_ENTRIES);
    expect(result.overflowDenialCount).toBe(7);
    expect(() => assertSyntheticAdmission(result)).toThrowError(ElizaError);
  });
});

describe("ambient connector config through the real collector", () => {
  it("collects plugin-imessage from ambient connectors and denies it in synthetic-mode execution", () => {
    const config = {
      connectors: { imessage: { enabled: true } },
    } as unknown as ElizaConfig;
    const reasons: PluginLoadReasons = new Map();
    const collected = collectPluginNames(config, reasons);
    expect(collected.has("@elizaos/plugin-imessage")).toBe(true);
    expect(reasons.get("@elizaos/plugin-imessage")).toBe("connectors.imessage");

    const result = applySyntheticAdmission(collected, reasons, {
      active: true,
      allowlist: new Set(),
    });
    expect(result.admitted.has("@elizaos/plugin-imessage")).toBe(false);
    expect(result.denials).toContainEqual({
      packageName: "@elizaos/plugin-imessage",
      provenance: "connectors.imessage",
    });
  });

  it("admits a scenario-declared connector, proving denial is policy not blanket", () => {
    const config = {
      connectors: { imessage: { enabled: true } },
    } as unknown as ElizaConfig;
    const reasons: PluginLoadReasons = new Map();
    const collected = collectPluginNames(config, reasons);
    const result = applySyntheticAdmission(collected, reasons, {
      active: true,
      allowlist: new Set(["@elizaos/plugin-imessage"]),
    });
    expect(result.admitted.has("@elizaos/plugin-imessage")).toBe(true);
    expect(
      result.denials.some(
        (denial) => denial.packageName === "@elizaos/plugin-imessage",
      ),
    ).toBe(false);
  });
});

describe("synthetic-mode boot fails closed with a persisted denial ledger (poisoned chat.db)", () => {
  it("denies the ambient iMessage connector at boot and never touches the poisoned Messages path", async () => {
    const stateDir = makeTempDir("synthetic-admission-state-");
    // The poison is a directory: any real open() of it as a SQLite database
    // fails with a recorded access issue, so the positive control below can
    // prove the instrument detects genuine access.
    const poisonDir = makeTempDir("synthetic-poison-messages-");
    const poisonedChatDbPath = path.join(poisonDir, "chat.db-poison");

    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_SYNTHETIC_MODE = "1";

    const config = {
      connectors: {
        imessage: { enabled: true, settings: { dbPath: poisonedChatDbPath } },
      },
    } as unknown as ElizaConfig;

    let thrown: unknown;
    try {
      await resolvePlugins(config, { quiet: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    const admissionError = thrown as ElizaError;
    expect(admissionError.code).toBe("SYNTHETIC_ADMISSION_DENIED");
    const context = admissionError.context as {
      denials: Array<{ packageName: string; provenance: string }>;
    };
    // The resolver's auto-enable pass translates ambient connector config
    // into plugins.allow before collection, so the denial's provenance names
    // that allow entry — proving admission also catches the auto-enable path.
    const imessageDenial = context.denials.find(
      (denial) => denial.packageName === "@elizaos/plugin-imessage",
    );
    expect(imessageDenial).toBeDefined();
    expect(imessageDenial?.provenance).toBe('plugins.allow["imessage"]');

    // The authoritative bounded ledger is retained on disk for CI.
    const ledgerPath = path.join(stateDir, "synthetic-admission-denials.json");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      denials: Array<{ packageName: string }>;
      overflowDenialCount: number;
    };
    expect(
      ledger.denials.some(
        (denial) => denial.packageName === "@elizaos/plugin-imessage",
      ),
    ).toBe(true);

    // Poison proof, negative half: the boot denied the plugin before any
    // module import, so nothing opened, statted, or created SQLite siblings
    // (-wal/-shm) beside the poisoned Messages path.
    expect(readdirSync(poisonDir)).toEqual([]);
    const { getLastChatDbAccessIssue } = await import(
      "../../../../plugins/plugin-imessage/src/chatdb-reader.ts"
    );
    expect(getLastChatDbAccessIssue(poisonedChatDbPath)).toBeNull();
  });

  it("denies filesystem drop-in plugins from the custom and ejected directories (late-source controls)", async () => {
    const stateDir = makeTempDir("synthetic-admission-dropin-");
    // Filesystem sources populate the load set AFTER config/env collection;
    // these controls pin that admission still gates them (the bypass a
    // reviewer demonstrated against the first head of this change).
    mkdirSync(
      path.join(stateDir, "plugins", "custom", "dropin-bypass-control"),
      {
        recursive: true,
      },
    );
    mkdirSync(
      path.join(stateDir, "plugins", "ejected", "ejected-bypass-control"),
      { recursive: true },
    );

    process.env.ELIZA_STATE_DIR = stateDir;
    process.env.ELIZA_SYNTHETIC_MODE = "1";

    let thrown: unknown;
    try {
      await resolvePlugins({} as unknown as ElizaConfig, { quiet: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ElizaError);
    const admissionError = thrown as ElizaError;
    expect(admissionError.code).toBe("SYNTHETIC_ADMISSION_DENIED");
    const context = admissionError.context as {
      denials: Array<{ packageName: string; provenance: string }>;
    };
    expect(context.denials).toContainEqual({
      packageName: "dropin-bypass-control",
      provenance: "custom plugins dir",
    });
    expect(context.denials).toContainEqual({
      packageName: "ejected-bypass-control",
      provenance: "ejected plugins dir",
    });

    const ledger = JSON.parse(
      readFileSync(
        path.join(stateDir, "synthetic-admission-denials.json"),
        "utf8",
      ),
    ) as { denials: Array<{ packageName: string }> };
    const ledgerNames = ledger.denials.map((denial) => denial.packageName);
    expect(ledgerNames).toContain("dropin-bypass-control");
    expect(ledgerNames).toContain("ejected-bypass-control");
  });

  it("positive control: the real chat.db reader records access when it does touch the poison", async () => {
    const poisonDir = makeTempDir("synthetic-poison-positive-");
    // A directory at the database path guarantees the open fails while still
    // registering the attempt — proving the negative half's instrument would
    // have caught a real access.
    const { openChatDb, getLastChatDbAccessIssue } = await import(
      "../../../../plugins/plugin-imessage/src/chatdb-reader.ts"
    );
    const reader = await openChatDb(poisonDir);
    expect(reader).toBeNull();
    const issue = getLastChatDbAccessIssue(poisonDir);
    expect(issue).not.toBeNull();
    expect(issue?.path).toBe(poisonDir);
  });
});

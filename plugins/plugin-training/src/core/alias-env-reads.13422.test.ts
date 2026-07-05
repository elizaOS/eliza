/**
 * Proves the P7 training-CLI env reads migrated to the alias-aware reader in
 * #13422 keep the brand-alias contract for `ELIZA_STATE_DIR` — the only
 * alias-table key read at the four migrated sites (`core/cli.ts`
 * export-trajectories input dir + rollback-prompt store root, `cli/train.ts`
 * artifact store root). A branded `MILADY_STATE_DIR` resolves through the real
 * shared `readAliasedEnv` those lines now call, the canonical `ELIZA_STATE_DIR`
 * wins when both are set, a blank value is treated as unset, and resolution
 * never materializes the `ELIZA_STATE_DIR` mirror on `process.env`. The migrated
 * sites are un-exported command handlers that `process.exit`, so this drives the
 * exact resolver expression they evaluate (same approach as the P2 boot-decision
 * coverage in `packages/app-core/src/alias-env-reads.13422.test.ts`).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildBrandEnvAliases,
  getBootConfig,
  readAliasedEnv,
  setBootConfig,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ALIAS_PAIRS = buildBrandEnvAliases("MILADY");
const TRACKED = ["MILADY_STATE_DIR", "ELIZA_STATE_DIR", "TRAINING_STATE_DIR"];

const savedConfig = getBootConfig();
const savedEnv: Record<string, string | undefined> = {};

// The state-dir default shared by all four migrated call sites when neither the
// branded nor the canonical key is set.
const DEFAULT_STATE_DIR = join(homedir(), ".eliza");

// core/cli.ts cmdExportTrajectories: the trajectory input dir derived from the
// migrated `readAliasedEnv("ELIZA_STATE_DIR") ?? ~/.eliza` state root.
const exportTrajectoriesInputDir = (): string =>
  join(readAliasedEnv("ELIZA_STATE_DIR") ?? DEFAULT_STATE_DIR, "trajectories");

// cli/train.ts: TRAINING_STATE_DIR (raw, not aliased) still wins; the aliased
// ELIZA_STATE_DIR read is the second precedence tier.
const trainStateDir = (): string =>
  process.env.TRAINING_STATE_DIR?.trim() ||
  readAliasedEnv("ELIZA_STATE_DIR") ||
  DEFAULT_STATE_DIR;

beforeEach(() => {
  for (const key of TRACKED) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Pin the alias table on the immutable BootConfig exactly as a branded
  // (MILADY) app boot does — this is what makes MILADY_* resolvable without the
  // process.env mirror.
  setBootConfig({ ...savedConfig, envAliases: ALIAS_PAIRS });
});

afterEach(() => {
  for (const key of TRACKED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  setBootConfig(savedConfig);
});

describe("plugin-training ELIZA_STATE_DIR alias reads (#13422 P7)", () => {
  it("resolves a branded MILADY_STATE_DIR without writing the ELIZA_ mirror", () => {
    process.env.MILADY_STATE_DIR = "/var/milady/state";

    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/var/milady/state");
    expect(exportTrajectoriesInputDir()).toBe("/var/milady/state/trajectories");
    expect(trainStateDir()).toBe("/var/milady/state");
    // Security property: the read must not synthesize the canonical mirror.
    expect(process.env.ELIZA_STATE_DIR).toBeUndefined();
  });

  it("prefers the canonical ELIZA_STATE_DIR over the branded alias", () => {
    process.env.ELIZA_STATE_DIR = "/var/eliza/state";
    process.env.MILADY_STATE_DIR = "/var/milady/state";

    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/var/eliza/state");
    expect(exportTrajectoriesInputDir()).toBe("/var/eliza/state/trajectories");
    expect(trainStateDir()).toBe("/var/eliza/state");
  });

  it("treats a blank ELIZA_STATE_DIR as unset and still surfaces the branded alias", () => {
    process.env.ELIZA_STATE_DIR = "   ";
    process.env.MILADY_STATE_DIR = "/var/milady/state";

    // empty-is-unset: the blank canonical value must not shadow the alias.
    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBe("/var/milady/state");
    expect(exportTrajectoriesInputDir()).toBe("/var/milady/state/trajectories");
  });

  it("falls back to the ~/.eliza default when neither key is set", () => {
    expect(readAliasedEnv("ELIZA_STATE_DIR")).toBeUndefined();
    expect(exportTrajectoriesInputDir()).toBe(
      join(DEFAULT_STATE_DIR, "trajectories"),
    );
    expect(trainStateDir()).toBe(DEFAULT_STATE_DIR);
  });

  it("keeps the raw TRAINING_STATE_DIR ahead of the aliased ELIZA_STATE_DIR in train.ts", () => {
    process.env.TRAINING_STATE_DIR = "/var/training/state";
    process.env.MILADY_STATE_DIR = "/var/milady/state";

    expect(trainStateDir()).toBe("/var/training/state");
  });
});

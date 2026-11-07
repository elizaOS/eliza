/**
 * `selectPrunableBackupIds` decides which sandbox backups `pruneBackups`
 * deletes. At the keep-cap boundary, backups that share a millisecond
 * timestamp are ordered by id. That order must be code-unit order: ICU
 * collation (`localeCompare`) ranks "aa…" after "b…" under Danish rules, so
 * a locale-ordered tie-break deletes a different restore point on hosts
 * whose locale differs.
 *
 * Bun ignores `LC_ALL`, so the locale cases run in Node child processes
 * (the repo's pinned runtime), which honor it. Each child imports this
 * module's TypeScript source directly and prints the prunable ids as JSON.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type BackupChainNode, selectPrunableBackupIds } from "./agent-backup-diff";

const AA = "aa000000-0000-4000-8000-000000000001";
const B0 = "b0000000-0000-4000-8000-000000000002";
const OLD = "c0000000-0000-4000-8000-000000000003";

const TIED_NODES: BackupChainNode[] = [
  { id: B0, backupKind: "full", parentBackupId: null, createdAtMs: 1000 },
  { id: AA, backupKind: "full", parentBackupId: null, createdAtMs: 1000 },
  { id: OLD, backupKind: "full", parentBackupId: null, createdAtMs: 500 },
];

function prunableIdsUnderLocale(locale: string): string[] {
  const moduleUrl = pathToFileURL(join(import.meta.dir, "agent-backup-diff.ts")).href;
  const script = [
    `import { selectPrunableBackupIds } from ${JSON.stringify(moduleUrl)};`,
    `const nodes = ${JSON.stringify(TIED_NODES)};`,
    "console.log(JSON.stringify(selectPrunableBackupIds(nodes, 1)));",
  ].join("\n");
  const result = spawnSync("node", ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, LANG: locale, LC_ALL: locale },
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(`node child (${locale}) failed: ${result.stderr || String(result.error)}`);
  }
  return JSON.parse(result.stdout.trim()) as string[];
}

describe("selectPrunableBackupIds prune tie-break", () => {
  test("keeps the same tied backup under en_US and da_DK locales", () => {
    const enUs = prunableIdsUnderLocale("en_US.UTF-8");
    const daDk = prunableIdsUnderLocale("da_DK.UTF-8");
    // Code-unit order keeps AA (aa… < b0…); only B0 and the older backup prune.
    expect(enUs).toEqual([B0, OLD]);
    expect(daDk).toEqual([B0, OLD]);
    expect(daDk).toEqual(enUs);
  }, 60_000);

  test("still pulls ancestors of a kept incremental into the keep set", () => {
    const child: BackupChainNode = {
      id: AA,
      backupKind: "incremental",
      parentBackupId: OLD,
      createdAtMs: 1000,
    };
    const rival: BackupChainNode = {
      id: B0,
      backupKind: "full",
      parentBackupId: null,
      createdAtMs: 1000,
    };
    const base: BackupChainNode = {
      id: OLD,
      backupKind: "full",
      parentBackupId: null,
      createdAtMs: 500,
    };
    expect(selectPrunableBackupIds([rival, child, base], 1)).toEqual([B0]);
  });
});

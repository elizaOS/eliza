/**
 * Pins the restorable-state predicate to a single source of truth: the TS
 * helper and both SQL copies in the 0244 lease guard must agree. (gc.ts has
 * broader lifecycle IN-lists that legitimately superset this predicate.)
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentBackupCatalogState } from "../../schemas/agent-sandboxes";
import { hasAgentBackupRestoreAuthority } from "../agent-backup-restore-authority";

const RESTORABLE: AgentBackupCatalogState[] = ["protected", "retained", "restore_verified"];
const NON_RESTORABLE: AgentBackupCatalogState[] = [
  "scheduled",
  "primary_verified",
  "secondary_pending",
  "expiration_pending",
  "deleting",
  "deleted",
  "failed_terminal",
];

function sqlInLists(source: string): string[][] {
  return [...source.matchAll(/catalog_state[")\s]* IN \(([^)]+)\)/g)].map((match) =>
    [...match[1].matchAll(/'([a-z_]+)'/g)].map(([, state]) => state).sort(),
  );
}

describe("restorable-state predicate binding", () => {
  test("the TS helper accepts exactly the restorable states", () => {
    for (const state of RESTORABLE) expect(hasAgentBackupRestoreAuthority(state)).toBe(true);
    for (const state of NON_RESTORABLE) expect(hasAgentBackupRestoreAuthority(state)).toBe(false);
    expect(hasAgentBackupRestoreAuthority(null)).toBe(false);
  });

  test("every SQL IN-list copy matches the helper's set", () => {
    const expected = [...RESTORABLE].sort();
    const guard = readFileSync(
      join(import.meta.dir, "../../migrations/0244_agent_backup_restore_lease_guard.sql"),
      "utf8",
    );
    const guardLists = sqlInLists(guard);
    expect(guardLists.length).toBe(2);
    for (const list of guardLists) expect(list).toEqual(expected);
  });
});

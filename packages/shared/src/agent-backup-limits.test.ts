/**
 * Pins the v1 agent-backup size contract: the retain budget can never exceed
 * what restore accepts.
 *
 * The production canary in #17172 retained a snapshot Cloud allowed (256 MiB)
 * but restore could not consume (128 MiB cap), producing a backup that
 * authorized a cutover and was impossible to restore. These tests hold the
 * clamp that makes that state unreachable — including through the operator env
 * override, which previously could re-open the gap by configuration alone.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  resolveRetainableAgentBackupBytes,
} from "./agent-backup-limits.js";

const MIB = 1024 * 1024;

describe("agent-backup limits", () => {
  it("pins the canonical restorable ceiling at 128 MiB", () => {
    // The smallest consumer on the restore path (the agent's /api/restore body
    // cap) is what makes a backup restorable at all; the canonical limit must
    // equal it, not the larger retain-side budget that caused #17172.
    expect(MAX_RESTORABLE_AGENT_BACKUP_BYTES).toBe(128 * MIB);
  });

  it("defaults to the canonical ceiling when no override is set", () => {
    expect(resolveRetainableAgentBackupBytes(undefined)).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
  });

  it("honors an override that LOWERS the retain budget", () => {
    // Lowering is the override's real purpose (staging soak, constrained
    // worker) and stays safe: a smaller retained payload is still restorable.
    expect(resolveRetainableAgentBackupBytes(String(32 * MIB))).toBe(32 * MIB);
  });

  it("clamps an override that would RAISE the retain budget past restore", () => {
    // The #17172 regression in one line: configuration must not be able to
    // retain more than restore accepts.
    expect(resolveRetainableAgentBackupBytes(String(512 * MIB))).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
    // The exact pre-fix value that produced the unrestorable canary snapshot.
    expect(resolveRetainableAgentBackupBytes(String(256 * MIB))).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
  });

  it("treats an absent or blank override as unset and defaults", () => {
    // Blank is indistinguishable from unset in a systemd EnvironmentFile, so it
    // stays a default rather than a hard failure.
    for (const raw of [undefined, "", "   "]) {
      expect(resolveRetainableAgentBackupBytes(raw)).toBe(
        MAX_RESTORABLE_AGENT_BACKUP_BYTES,
      );
    }
  });

  it("fails fast on a configured-but-invalid override instead of defaulting", () => {
    // An operator who set the variable meant to change the budget. Silently
    // running on the canonical limit would hide the misconfiguration behind
    // behavior that looks deliberate.
    for (const raw of ["not-a-number", "0", "-1", "NaN", "1e9", " 12 34 "]) {
      expect(() => resolveRetainableAgentBackupBytes(raw)).toThrow(
        /Invalid snapshot retain budget/,
      );
    }
  });

  it("rejects a malformed numeric PREFIX rather than silently misreading it", () => {
    // `Number.parseInt` reads all three of these as 128 — the silent misread
    // this parser exists to prevent (an operator writing a unit suffix would
    // get a 128-BYTE budget without a word).
    for (const raw of ["128MiB", "128abc", "128_000", "0x80"]) {
      expect(() => resolveRetainableAgentBackupBytes(raw)).toThrow(
        /Invalid snapshot retain budget/,
      );
    }
    // Surrounding whitespace is only formatting, so it is trimmed, not rejected.
    expect(resolveRetainableAgentBackupBytes("  1048576  ")).toBe(1048576);
  });

  it("accepts the exact limit and clamps limit+1 (boundary)", () => {
    expect(
      resolveRetainableAgentBackupBytes(
        String(MAX_RESTORABLE_AGENT_BACKUP_BYTES),
      ),
    ).toBe(MAX_RESTORABLE_AGENT_BACKUP_BYTES);
    expect(
      resolveRetainableAgentBackupBytes(
        String(MAX_RESTORABLE_AGENT_BACKUP_BYTES + 1),
      ),
    ).toBe(MAX_RESTORABLE_AGENT_BACKUP_BYTES);
  });

  it("never resolves a retain budget above the restorable ceiling, for any input", () => {
    // The anti-drift invariant itself: whatever an operator sets, the retain
    // side stays within what restore can consume.
    const inputs = [
      undefined,
      "1",
      "1048576",
      String(128 * MIB),
      String(1024 * MIB),
      "999999999999",
    ];
    for (const raw of inputs) {
      expect(resolveRetainableAgentBackupBytes(raw)).toBeLessThanOrEqual(
        MAX_RESTORABLE_AGENT_BACKUP_BYTES,
      );
    }
  });
});

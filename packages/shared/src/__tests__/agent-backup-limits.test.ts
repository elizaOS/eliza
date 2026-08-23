import { describe, expect, it } from "vitest";
import {
  MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  resolveRetainableAgentBackupBytes,
  SnapshotPayloadTooLargeError,
} from "./agent-backup-limits.ts";

describe("resolveRetainableAgentBackupBytes", () => {
  it("defaults to the canonical limit when absent", () => {
    expect(resolveRetainableAgentBackupBytes(undefined)).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
    expect(resolveRetainableAgentBackupBytes("")).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
    expect(resolveRetainableAgentBackupBytes("  ")).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
  });

  it("clamps overrides above the canonical limit", () => {
    expect(resolveRetainableAgentBackupBytes("999999999")).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
  });

  it("accepts lower overrides", () => {
    expect(resolveRetainableAgentBackupBytes("1048576")).toBe(1048576);
  });

  it("rejects malformed overrides instead of silently falling back", () => {
    for (const bad of ["128MiB", "128abc", "-5", "0", "1.5", "abc"]) {
      expect(() => resolveRetainableAgentBackupBytes(bad)).toThrow(
        "Invalid snapshot retain budget",
      );
    }
  });
});

describe("SnapshotPayloadTooLargeError", () => {
  it("carries bytes and limit and classifies as too-large", () => {
    const err = new SnapshotPayloadTooLargeError(200, 100);
    expect(err.name).toBe("SnapshotPayloadTooLargeError");
    expect(err.payloadBytes).toBe(200);
    expect(err.limitBytes).toBe(100);
    expect(err.message).toContain("exceeds the v1 restorable limit");
    expect(err instanceof Error).toBe(true);
  });
});

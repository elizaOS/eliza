/**
 * Coverage for agent-backup-limits.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_RESTORABLE_AGENT_BACKUP_BYTES,
  resolveRetainableAgentBackupBytes,
  SnapshotPayloadTooLargeError,
} from "./agent-backup-limits.js";

describe("agent-backup-limits", () => {
  it("exposes the canonical restorable ceiling", () => {
    expect(MAX_RESTORABLE_AGENT_BACKUP_BYTES).toBe(128 * 1024 * 1024);
  });

  it("defaults when the override is absent or blank", () => {
    expect(resolveRetainableAgentBackupBytes(undefined)).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
    expect(resolveRetainableAgentBackupBytes("")).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
    expect(resolveRetainableAgentBackupBytes("   ")).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
  });

  it("accepts a lower override", () => {
    expect(resolveRetainableAgentBackupBytes("1048576")).toBe(1024 * 1024);
  });

  it("clamps an override above the canonical ceiling", () => {
    expect(resolveRetainableAgentBackupBytes("999999999")).toBe(
      MAX_RESTORABLE_AGENT_BACKUP_BYTES,
    );
  });

  it("rejects malformed and non-positive overrides (no parseInt prefix reads)", () => {
    expect(() => resolveRetainableAgentBackupBytes("128MiB")).toThrow();
    expect(() => resolveRetainableAgentBackupBytes("128abc")).toThrow();
    expect(() => resolveRetainableAgentBackupBytes("0")).toThrow();
    expect(() => resolveRetainableAgentBackupBytes("-1")).toThrow();
    expect(() => resolveRetainableAgentBackupBytes("1.5")).toThrow();
  });

  it("SnapshotPayloadTooLargeError is a typed Error with formatted message", () => {
    const err = new SnapshotPayloadTooLargeError(200, 128);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SnapshotPayloadTooLargeError");
    expect(err.payloadBytes).toBe(200);
    expect(err.limitBytes).toBe(128);
    expect(err.message).toContain("200 bytes");
    expect(err.message).toContain("128 bytes");
  });
});

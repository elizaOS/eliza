/**
 * Locks the v1 snapshot wire ceiling, its inclusive boundary, and the rule
 * that deployment overrides may tighten but never widen restorability.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES,
  AgentSnapshotV1WireLimitError,
  assertAgentSnapshotV1WireByteLength,
  resolveAgentSnapshotV1MaxWireBytes,
} from "./agent-snapshot.js";

describe("agent snapshot v1 wire contract", () => {
  it("accepts exactly the maximum restorable wire size", () => {
    expect(AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES).toBe(128 * 1024 * 1024);
    expect(() =>
      assertAgentSnapshotV1WireByteLength(AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES),
    ).not.toThrow();
  });

  it("rejects one byte above the maximum with a size-only typed error", () => {
    const receivedBytes = AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES + 1;
    expect(() => assertAgentSnapshotV1WireByteLength(receivedBytes)).toThrow(
      AgentSnapshotV1WireLimitError,
    );

    try {
      assertAgentSnapshotV1WireByteLength(receivedBytes);
    } catch (error) {
      expect(error).toMatchObject({
        name: "AgentSnapshotV1WireLimitError",
        receivedBytes,
        maxBytes: AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES,
      });
      expect((error as Error).message).not.toContain("payload contents");
    }
  });

  it("honors a lower deployment override", () => {
    expect(resolveAgentSnapshotV1MaxWireBytes("1048576")).toBe(1024 * 1024);
  });

  it("clamps a higher deployment override to the restorable ceiling", () => {
    expect(
      resolveAgentSnapshotV1MaxWireBytes(
        String(AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES + 1),
      ),
    ).toBe(AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES);
  });

  it("treats an absent or blank override as unset", () => {
    for (const configuredBytes of [undefined, "", "   "]) {
      expect(resolveAgentSnapshotV1MaxWireBytes(configuredBytes)).toBe(
        AGENT_SNAPSHOT_V1_MAX_WIRE_BYTES,
      );
    }
  });

  it("fails fast on configured malformed, non-positive, or unsafe values", () => {
    for (const configuredBytes of [
      "not-a-number",
      "0",
      "-1",
      "NaN",
      "1e9",
      "12.5",
      " 12 34 ",
      String(Number.MAX_SAFE_INTEGER + 1),
    ]) {
      expect(() => resolveAgentSnapshotV1MaxWireBytes(configuredBytes)).toThrow(
        /Invalid snapshot retain budget/,
      );
    }
  });

  it("rejects numeric prefixes instead of silently parsing a smaller budget", () => {
    for (const configuredBytes of ["128MiB", "128abc", "128_000", "0x80"]) {
      expect(() => resolveAgentSnapshotV1MaxWireBytes(configuredBytes)).toThrow(
        /Invalid snapshot retain budget/,
      );
    }
    expect(resolveAgentSnapshotV1MaxWireBytes("  1048576  ")).toBe(1024 * 1024);
  });
});

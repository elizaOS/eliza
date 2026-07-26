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
});

/**
 * Fail-closed canonical walk for the agent-backup integrity gate.
 *
 * `assertManifest` canonicalizes `manifest.integrity.componentHashes` — file
 * content read straight out of a stored backup — and
 * `decryptLocalBackupEnvelope` canonicalizes the decrypted snapshot BEFORE
 * `assertManifest` has validated its shape. On origin develop the sorted-key
 * recursion behind `stableJson` carried no depth counter, no node budget and no
 * cycle guard, so a deep or cyclic payload `RangeError`ed the very check whose
 * job is to reject a malformed backup: the restore had no reachable error path.
 * It now fails closed with a typed `ElizaError`, and honest manifests keep the
 * hashes they already had.
 */
import { ElizaError } from "@elizaos/core";
import { CANONICAL_JSON_UNBOUNDED } from "@elizaos/shared/canonical-json";
import { describe, expect, it } from "vitest";
import { restoreAgentSnapshot } from "./agent-backup.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const COMPONENT = { sha256: "0".repeat(64), size: 0 };

function snapshotWith(componentHashes: unknown): unknown {
  return {
    memories: [],
    config: {},
    workspaceFiles: {},
    manifest: {
      format: "elizaos.agent-backup",
      schemaVersion: 1,
      agentId: AGENT_ID,
      components: {
        database: { ...COMPONENT, kind: "pglite-files" },
        media: COMPONENT,
        vault: COMPONENT,
        character: COMPONENT,
        stateFiles: COMPONENT,
      },
      integrity: { componentHashes },
    },
  };
}

function deepChain(levels: number): unknown {
  let node: Record<string, unknown> = {};
  const root = node;
  for (let i = 0; i < levels; i += 1) {
    const next: Record<string, unknown> = {};
    node.next = next;
    node = next;
  }
  return root;
}

const runtime = { agentId: AGENT_ID } as never;

async function expectUnbounded(componentHashes: unknown): Promise<void> {
  let caught: unknown;
  let threw = false;
  try {
    await restoreAgentSnapshot(runtime, snapshotWith(componentHashes) as never);
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(ElizaError);
  expect(caught).not.toBeInstanceOf(RangeError);
  expect((caught as ElizaError).code).toBe(CANONICAL_JSON_UNBOUNDED);
}

describe("agent backup manifest hashing is bounded", () => {
  it("fails closed on a 60k-deep componentHashes instead of RangeError", async () => {
    await expectUnbounded(deepChain(60_000));
  });

  it("fails closed on a cyclic componentHashes instead of RangeError", async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expectUnbounded(cyclic);
  });

  it("still rejects an honest-but-inconsistent manifest the way it always did", async () => {
    // The bound must not change what a well-formed backup does: this is the
    // ordinary hash-index mismatch, not a walk-budget failure.
    await expect(
      restoreAgentSnapshot(runtime, snapshotWith({ database: "x" }) as never),
    ).rejects.toThrow("Backup manifest component hash index is inconsistent");
  });

  it("accepts a consistent component hash index, so honest bytes are unchanged", async () => {
    const consistent = {
      database: COMPONENT.sha256,
      media: COMPONENT.sha256,
      vault: COMPONENT.sha256,
      character: COMPONENT.sha256,
      stateFiles: COMPONENT.sha256,
    };
    // Past the manifest gate the restore fails on infrastructure, never on the
    // canonical walk — that is the point: the integrity check now returns a
    // verdict instead of overflowing.
    await expect(
      restoreAgentSnapshot(runtime, snapshotWith(consistent) as never),
    ).rejects.not.toThrow(
      "Backup manifest component hash index is inconsistent",
    );
  });
});

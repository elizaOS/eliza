/**
 * Fail-closed canonical walk for incremental-backup state hashing.
 *
 * Origin develop `RangeError`ed `computeStateHash` and `diffBackupState` on a
 * deep or cyclic `state.config` — agent- and plugin-controlled content — because
 * the sorted-key recursion behind `stableStringify` had no depth counter, no
 * node budget and no cycle guard. It now fails closed with a typed
 * `ElizaError` / `CANONICAL_JSON_UNBOUNDED`, and every state that hashed before
 * still hashes to the same digest.
 */
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { CANONICAL_JSON_UNBOUNDED } from "@elizaos/shared/canonical-json";
import { describe, expect, test } from "vitest";
import { computeStateHash, diffBackupState, emptyBackupState } from "./agent-backup-diff";

/** The unbounded body this file used to carry, kept as the hash oracle. */
function legacyCanonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyCanonicalize);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = legacyCanonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function legacyStateHash(state: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(legacyCanonicalize(state)))
    .digest("hex");
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

function expectUnbounded(fn: () => unknown): void {
  let caught: unknown;
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    caught = error;
  }
  expect(threw).toBe(true);
  expect(caught).toBeInstanceOf(ElizaError);
  expect(caught).not.toBeInstanceOf(RangeError);
  expect((caught as ElizaError).code).toBe(CANONICAL_JSON_UNBOUNDED);
}

function stateWithConfig(config: Record<string, unknown>) {
  const state = emptyBackupState();
  Object.assign(state.config, config);
  return state;
}

describe("bounded state hashing", () => {
  test("computeStateHash fails closed on a 60k-deep config", () => {
    expectUnbounded(() => computeStateHash(stateWithConfig({ deep: deepChain(60_000) })));
  });

  test("computeStateHash fails closed on a cyclic config", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectUnbounded(() => computeStateHash(stateWithConfig({ cyclic })));
  });

  test("diffBackupState fails closed on a deep or cyclic config value", () => {
    const base = stateWithConfig({ deep: { shallow: true }, cyclic: { shallow: true } });
    expectUnbounded(() => diffBackupState(base, stateWithConfig({ deep: deepChain(60_000) })));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expectUnbounded(() => diffBackupState(base, stateWithConfig({ cyclic })));
  });

  test("honest states keep the digest they already had", () => {
    const shared = { b: 1, a: [1, 2, { deep: true }] };
    const honest = {
      memories: [
        { role: "user", text: "hi 🦊", timestamp: 1 },
        { role: "assistant", text: "hello", timestamp: 2 },
      ],
      config: {
        zeta: 1,
        // An honest shared reference (DAG): the same object down two branches
        // is not a cycle and must still hash exactly as it did before.
        x: shared,
        y: shared,
        nested: { a: { b: { c: [1, null, "two", true] } } },
        empty: {},
        nul: null,
      },
      workspaceFiles: { "b.txt": "second", "a.txt": "first" },
    };
    expect(computeStateHash(honest)).toBe(legacyStateHash(honest));
  });

  test("a deeply-nested but finite honest config still hashes, unchanged", () => {
    let value: unknown = "leaf";
    for (let i = 0; i < 40; i += 1) value = { level: value };
    const state = stateWithConfig({ plugin: value });
    expect(computeStateHash(state)).toBe(legacyStateHash(state));
  });

  test("key insertion order still does not change the digest", () => {
    const left = stateWithConfig({ a: 1, b: { x: 1, y: 2 } });
    const right = stateWithConfig({ b: { y: 2, x: 1 }, a: 1 });
    expect(computeStateHash(left)).toBe(computeStateHash(right));
  });
});

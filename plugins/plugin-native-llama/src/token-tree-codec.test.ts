/**
 * Round-trip tests for `serializeTokenTree` / `deserializeTokenTree`.
 *
 * The wire format is what the native sampler hook consumes; correctness of
 * the flat layout is load-bearing. These tests pin:
 *   - identity round-trip on basic inputs
 *   - prefix-sharing produces a single shared parent (not two duplicated
 *     subtrees)
 *   - the encoder is deterministic across runs
 *   - the decoder rejects malformed inputs rather than producing garbage
 */

import { describe, expect, it } from "vitest";
import type { TokenTreeDescriptor } from "./definitions";
import { deserializeTokenTree, serializeTokenTree } from "./token-tree-codec";

function leavesAsSets(d: TokenTreeDescriptor): Set<string> {
  return new Set(d.leaves.map((l) => l.tokens.join(",")));
}

describe("token-tree-codec", () => {
  it("round-trips a simple descriptor", () => {
    const input: TokenTreeDescriptor = {
      path: "action",
      leaves: [
        { name: "PING", tokens: [12, 7] },
        { name: "PONG", tokens: [12, 9] },
      ],
    };
    const bytes = serializeTokenTree(input);
    const out = deserializeTokenTree(bytes);
    expect(out.path).toBe("action");
    expect(leavesAsSets(out)).toEqual(leavesAsSets(input));
  });

  it("preserves prefix sharing — two leaves sharing a head produce one shared root edge", () => {
    const input: TokenTreeDescriptor = {
      path: "parameters.kind",
      leaves: [
        { name: "alpha", tokens: [1, 2, 3] },
        { name: "alphabet", tokens: [1, 2, 3, 4, 5] },
      ],
    };
    const bytes = serializeTokenTree(input);
    // Manually count nodes: root + (1) + (2) + (3, terminal) + (4) + (5, terminal) = 6 nodes
    // Header: 4 (magic) + 4 (ver) + 4 (path_len) + path.length + 4 (total_nodes) = 16 + path
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pathLen = view.getUint32(8, true);
    const totalNodes = view.getUint32(12 + pathLen, true);
    expect(totalNodes).toBe(6);

    const out = deserializeTokenTree(bytes);
    const tokenLists = out.leaves.map((l) => l.tokens.join(","));
    expect(tokenLists).toContain("1,2,3");
    expect(tokenLists).toContain("1,2,3,4,5");
  });

  it("is deterministic — encoding the same descriptor twice produces byte-equal output", () => {
    const input: TokenTreeDescriptor = {
      path: "x",
      leaves: [
        { name: "b", tokens: [9, 8] },
        { name: "a", tokens: [9, 7] },
      ],
    };
    const a = serializeTokenTree(input);
    const b = serializeTokenTree(input);
    expect(a.byteLength).toBe(b.byteLength);
    for (let i = 0; i < a.byteLength; i++) {
      expect(a[i]).toBe(b[i]);
    }
  });

  it("handles an empty leaf list as a zero-leaf descriptor", () => {
    const input: TokenTreeDescriptor = { path: "empty", leaves: [] };
    const out = deserializeTokenTree(serializeTokenTree(input));
    expect(out.path).toBe("empty");
    expect(out.leaves).toEqual([]);
  });

  it("rejects buffers with a bad magic", () => {
    const fake = new Uint8Array(16);
    expect(() => deserializeTokenTree(fake)).toThrow(/bad magic/);
  });

  it("rejects truncated input", () => {
    const valid = serializeTokenTree({
      path: "p",
      leaves: [{ name: "x", tokens: [1] }],
    });
    const truncated = valid.subarray(0, valid.byteLength - 4);
    expect(() => deserializeTokenTree(truncated)).toThrow();
  });

  it("round-trips multi-byte path strings (utf-8 safe)", () => {
    const input: TokenTreeDescriptor = {
      path: "résumé.fields[0]",
      leaves: [{ name: "ok", tokens: [1, 2] }],
    };
    const out = deserializeTokenTree(serializeTokenTree(input));
    expect(out.path).toBe("résumé.fields[0]");
  });
});

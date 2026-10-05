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
 *   - a multi-parent complete DAG (origin hang: 26 nodes / 1.5 KiB → 33M paths)
 *     is rejected immediately instead of exploding `collectLeaves`
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

  it("rejects a multi-parent DAG instead of exploding collectLeaves", () => {
    // Every node points at every later node. Origin collectLeaves on 26
    // nodes / 1551 bytes expanded 33,554,431 paths (~2.3s). The encoder
    // never emits a second inbound edge.
    const bomb = buildCompleteForwardDag(26);
    expect(bomb.byteLength).toBe(1551);
    const started = performance.now();
    expect(() => deserializeTokenTree(bomb)).toThrow(/multiple parents/);
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("rejects nodes that are not connected to the root", () => {
    expect(() => deserializeTokenTree(buildDisconnectedTree())).toThrow(
      /not connected to root/,
    );
  });

  it("rejects descriptors with non-finite or invalid tokenIds during serialization", () => {
    expect(() =>
      serializeTokenTree({
        path: "test",
        leaves: [{ name: "leaf-nan", tokens: [NaN as unknown as number] }],
      }),
    ).toThrow(/invalid tokenId/);

    expect(() =>
      serializeTokenTree({
        path: "test",
        leaves: [
          {
            name: "leaf-inf",
            tokens: [Number.POSITIVE_INFINITY as unknown as number],
          },
        ],
      }),
    ).toThrow(/invalid tokenId/);

    expect(() =>
      serializeTokenTree({
        path: "test",
        leaves: [{ name: "leaf-neg", tokens: [-5] }],
      }),
    ).toThrow(/invalid tokenId/);

    expect(() =>
      serializeTokenTree({
        path: "test",
        leaves: [{ name: "leaf-float", tokens: [3.14] }],
      }),
    ).toThrow(/invalid tokenId/);
  });

  it("serializes and deserializes descriptors with valid tokenIds and multiple branches", () => {
    const input = {
      path: "schema.field",
      leaves: [
        { name: "zero", tokens: [0, 10, 20] },
        { name: "high", tokens: [0, 10, 30] },
        { name: "other", tokens: [50000, 100] },
      ],
    };
    const serialized = serializeTokenTree(input);
    const deserialized = deserializeTokenTree(serialized);
    expect(deserialized.path).toBe("schema.field");
    expect(deserialized.leaves.length).toBe(3);
    expect(leavesAsSets(deserialized)).toEqual(leavesAsSets(input));
  });
});

/** Hostile RTKT v1 buffer: node i children = i+1..n-1. */
function buildCompleteForwardDag(n: number): Uint8Array {
  const MAGIC = 0x544b5452;
  const ROOT_TOKEN_ID = -1;
  const pathBytes = new TextEncoder().encode("x");
  let body = 4;
  for (let i = 0; i < n; i++) {
    body += 9 + (n - 1 - i) * 4;
  }
  const buf = new ArrayBuffer(12 + pathBytes.length + body);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;
  view.setUint32(offset, MAGIC, true);
  offset += 4;
  view.setUint32(offset, 1, true);
  offset += 4;
  view.setUint32(offset, pathBytes.length, true);
  offset += 4;
  bytes.set(pathBytes, offset);
  offset += pathBytes.length;
  view.setUint32(offset, n, true);
  offset += 4;
  for (let i = 0; i < n; i++) {
    view.setInt32(offset, i === 0 ? ROOT_TOKEN_ID : i, true);
    offset += 4;
    view.setUint8(offset, 1);
    offset += 1;
    const childCount = n - 1 - i;
    view.setUint32(offset, childCount, true);
    offset += 4;
    for (let j = i + 1; j < n; j++) {
      view.setUint32(offset, j, true);
      offset += 4;
    }
  }
  return bytes;
}

function buildDisconnectedTree(): Uint8Array {
  const bytes = new Uint8Array(12 + 1 + 4 + 9 * 2);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x544b5452, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, 1, true);
  bytes[12] = 0x78;
  view.setUint32(13, 2, true);
  view.setInt32(17, -1, true);
  view.setUint32(22, 0, true);
  view.setInt32(26, 7, true);
  view.setUint8(30, 1);
  view.setUint32(31, 0, true);
  return bytes;
}

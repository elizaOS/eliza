/**
 * Flat byte-serialization for `TokenTreeDescriptor` payloads.
 *
 * The native sampler hook consumes a length-prefixed flat layout rather than
 * the `Map`-based trie used in TS; the codec here is the one place that
 * conversion lives. Layout (little-endian int32 throughout):
 *
 *   header:
 *     u32  magic               = 0x544B5452  ("RTKT")
 *     u32  version             = 1
 *     u32  path_len            (utf-8 bytes)
 *     ...  path                (utf-8 bytes, no trailing NUL)
 *     u32  total_nodes
 *
 *   per node (root first, DFS pre-order):
 *     i32  token_id            (root carries TRIE_ROOT_TOKEN_ID = -1)
 *     u8   terminal            (0 or 1)
 *     u32  num_children
 *     u32  child_ptrs[num_children]   (node indices, monotonically > self)
 *
 * The "child_ptrs" entries point into the same flat node array — the sampler
 * walks by index, never by allocation. Pre-order traversal guarantees parent
 * index < child index, so a single forward pass can resolve every pointer
 * without a second materialisation step.
 *
 * Round-trip invariants:
 *   - `deserializeTokenTree(serializeTokenTree(d))` is structurally equal to
 *     `d` modulo leaf ordering (the codec preserves the input order; callers
 *     wanting a canonical encoding should pre-sort with the same key the
 *     wire format uses, see `buildTokenTreeDescriptor`).
 *   - Encoding is deterministic: identical inputs produce byte-identical
 *     outputs.
 */

import type { TokenTreeDescriptor, TokenSequence } from "./definitions";

const MAGIC = 0x544b5452; // "RTKT" (Runtime Token Tree)
const VERSION = 1;
const ROOT_TOKEN_ID = -1;

interface TrieNode {
  tokenId: number;
  terminal: boolean;
  children: Map<number, TrieNode>;
}

function buildTrie(leaves: ReadonlyArray<TokenSequence>): TrieNode {
  const root: TrieNode = {
    tokenId: ROOT_TOKEN_ID,
    terminal: false,
    children: new Map(),
  };
  for (const leaf of leaves) {
    if (leaf.tokens.length === 0) continue;
    let node = root;
    for (const tok of leaf.tokens) {
      let next = node.children.get(tok);
      if (!next) {
        next = { tokenId: tok, terminal: false, children: new Map() };
        node.children.set(tok, next);
      }
      node = next;
    }
    node.terminal = true;
  }
  return root;
}

function flattenPreOrder(root: TrieNode): TrieNode[] {
  // Iterative pre-order so the recursion depth is bounded by the explicit
  // stack — guards against pathological deep tries hitting the JS stack.
  const out: TrieNode[] = [];
  const stack: TrieNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    out.push(node);
    // Push children in reverse so iteration order is ascending tokenId —
    // gives a stable, replayable byte sequence across runs.
    const sorted = [...node.children.values()].sort(
      (a, b) => a.tokenId - b.tokenId,
    );
    for (let i = sorted.length - 1; i >= 0; i--) {
      stack.push(sorted[i]!);
    }
  }
  return out;
}

/**
 * Serialize a `TokenTreeDescriptor` to the flat binary wire format. The
 * returned buffer is suitable for handing directly to the native bridge as
 * an `ArrayBuffer` payload.
 */
export function serializeTokenTree(
  descriptor: TokenTreeDescriptor,
): Uint8Array {
  const encoder = new TextEncoder();
  const pathBytes = encoder.encode(descriptor.path);
  const root = buildTrie(descriptor.leaves);
  const flat = flattenPreOrder(root);
  const indexByNode = new Map<TrieNode, number>();
  flat.forEach((node, idx) => indexByNode.set(node, idx));

  // Two-pass size calc so we allocate exactly once.
  let bodySize = 4; // total_nodes
  for (const node of flat) {
    bodySize += 4 /* tokenId */ + 1 /* terminal */ + 4 /* num_children */;
    bodySize += node.children.size * 4;
  }
  const headerSize = 4 /* magic */ + 4 /* version */ + 4 /* path_len */ + pathBytes.length;
  const buf = new ArrayBuffer(headerSize + bodySize);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  let offset = 0;
  view.setUint32(offset, MAGIC, true);
  offset += 4;
  view.setUint32(offset, VERSION, true);
  offset += 4;
  view.setUint32(offset, pathBytes.length, true);
  offset += 4;
  bytes.set(pathBytes, offset);
  offset += pathBytes.length;
  view.setUint32(offset, flat.length, true);
  offset += 4;

  for (const node of flat) {
    view.setInt32(offset, node.tokenId, true);
    offset += 4;
    view.setUint8(offset, node.terminal ? 1 : 0);
    offset += 1;
    const sortedChildren = [...node.children.values()].sort(
      (a, b) => a.tokenId - b.tokenId,
    );
    view.setUint32(offset, sortedChildren.length, true);
    offset += 4;
    for (const child of sortedChildren) {
      const childIdx = indexByNode.get(child);
      if (childIdx == null) {
        throw new Error(
          "serializeTokenTree: child node missing from index — internal invariant violated",
        );
      }
      view.setUint32(offset, childIdx, true);
      offset += 4;
    }
  }

  return new Uint8Array(buf);
}

interface FlatNode {
  tokenId: number;
  terminal: boolean;
  childPtrs: number[];
}

function collectLeaves(flat: FlatNode[], rootIdx: number): TokenSequence[] {
  const out: TokenSequence[] = [];
  const stack: Array<{ idx: number; path: number[] }> = [
    { idx: rootIdx, path: [] },
  ];
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const node = flat[frame.idx];
    if (!node) continue;
    const path = node.tokenId === ROOT_TOKEN_ID ? frame.path : [...frame.path, node.tokenId];
    if (node.terminal && path.length > 0) {
      out.push({ name: path.join(","), tokens: path });
    }
    // Push children right-to-left so leaves come out in ascending-token
    // sort order — matches the encoder's traversal.
    for (let i = node.childPtrs.length - 1; i >= 0; i--) {
      stack.push({ idx: node.childPtrs[i]!, path });
    }
  }
  return out;
}

/**
 * Deserialize the flat wire format back into a `TokenTreeDescriptor`. Leaf
 * `name`s are synthesised as the comma-joined token id sequence — the
 * wire format intentionally does not round-trip the human-readable leaf
 * names (those are debugging-only on the encoder side and not consumed by
 * the native sampler), so callers needing the original names should keep
 * the source-side descriptor around alongside the bytes.
 *
 * Throws on truncated input, unknown magic, or unsupported version.
 */
export function deserializeTokenTree(input: Uint8Array): TokenTreeDescriptor {
  if (input.byteLength < 16) {
    throw new Error("deserializeTokenTree: input too short for header");
  }
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let offset = 0;
  const magic = view.getUint32(offset, true);
  offset += 4;
  if (magic !== MAGIC) {
    throw new Error(
      `deserializeTokenTree: bad magic 0x${magic.toString(16)} (expected 0x${MAGIC.toString(16)})`,
    );
  }
  const version = view.getUint32(offset, true);
  offset += 4;
  if (version !== VERSION) {
    throw new Error(
      `deserializeTokenTree: unsupported version ${version} (this build understands ${VERSION})`,
    );
  }
  const pathLen = view.getUint32(offset, true);
  offset += 4;
  if (offset + pathLen + 4 > input.byteLength) {
    throw new Error("deserializeTokenTree: truncated path / node-count");
  }
  const path = new TextDecoder().decode(input.subarray(offset, offset + pathLen));
  offset += pathLen;
  const totalNodes = view.getUint32(offset, true);
  offset += 4;

  const flat: FlatNode[] = [];
  for (let i = 0; i < totalNodes; i++) {
    if (offset + 9 > input.byteLength) {
      throw new Error(
        `deserializeTokenTree: truncated node ${i} of ${totalNodes}`,
      );
    }
    const tokenId = view.getInt32(offset, true);
    offset += 4;
    const terminal = view.getUint8(offset) === 1;
    offset += 1;
    const numChildren = view.getUint32(offset, true);
    offset += 4;
    if (offset + numChildren * 4 > input.byteLength) {
      throw new Error(
        `deserializeTokenTree: truncated children for node ${i}`,
      );
    }
    const childPtrs: number[] = [];
    for (let c = 0; c < numChildren; c++) {
      const ptr = view.getUint32(offset, true);
      offset += 4;
      if (ptr <= i || ptr >= totalNodes) {
        throw new Error(
          `deserializeTokenTree: invalid child pointer ${ptr} at node ${i}`,
        );
      }
      childPtrs.push(ptr);
    }
    flat.push({ tokenId, terminal, childPtrs });
  }

  if (flat.length === 0 || flat[0]!.tokenId !== ROOT_TOKEN_ID) {
    throw new Error(
      "deserializeTokenTree: root node missing or has non-sentinel tokenId",
    );
  }

  const leaves = collectLeaves(flat, 0);
  return { path, leaves };
}

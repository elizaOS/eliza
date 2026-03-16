/**
 * Merkle tree service for whitelist proof generation.
 *
 * Builds a Merkle tree from verified addresses in whitelist.json and
 * generates proofs that can be submitted to the smart contract's
 * `mintWhitelist(name, endpoint, capHash, proof[])` function.
 *
 * This is the missing bridge between:
 *   whitelist.json  →  Merkle tree  →  on-chain mintWhitelist()
 *
 * The contract stores a `merkleRoot()` and verifies each mint against
 * a proof derived from the caller's address.
 *
 * Standard: leaves = keccak256(abi.encodePacked(address))
 *           sorted pairs to ensure deterministic tree construction.
 *
 * @see drop-service.ts  — mintWithWhitelist() consumer
 * @see twitter-verify.ts — one source of whitelist addresses
 * @see nft-verify.ts     — another source of whitelist addresses
 */

import { logger } from "@elizaos/core";
import { ethers } from "ethers";
import { getVerifiedAddresses } from "./twitter-verify";

// ── Types ────────────────────────────────────────────────────────────────

export interface MerkleProofResult {
  /** The proof array (bytes32[]) to submit to mintWhitelist(). */
  proof: string[];
  /** The leaf hash for this address. */
  leaf: string;
  /** The root of the current tree. */
  root: string;
  /** Whether this address is in the tree. */
  isWhitelisted: boolean;
}

export interface MerkleTreeInfo {
  /** The root hash of the current tree. */
  root: string;
  /** Total number of addresses in the tree. */
  addressCount: number;
  /** All leaf hashes (sorted). */
  leaves: string[];
}

// ── Leaf hashing ─────────────────────────────────────────────────────────

/**
 * Hash an address into a Merkle leaf.
 *
 * Uses `keccak256(abi.encodePacked(address))` — the standard Solidity
 * pattern for OpenZeppelin MerkleProof verification.
 */
export function hashLeaf(address: string): string {
  return ethers.solidityPackedKeccak256(
    ["address"],
    [ethers.getAddress(address)], // checksummed
  );
}

// ── Merkle tree construction ─────────────────────────────────────────────

/**
 * Sort a pair of hashes for deterministic tree construction.
 * This ensures the tree is the same regardless of insertion order.
 */
function sortPair(a: string, b: string): [string, string] {
  return a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
}

/**
 * Hash two nodes together (internal node).
 */
function hashPair(a: string, b: string): string {
  const [left, right] = sortPair(a, b);
  return ethers.solidityPackedKeccak256(["bytes32", "bytes32"], [left, right]);
}

/**
 * Build a Merkle tree from an array of leaf hashes.
 *
 * Returns the tree as a 2D array where:
 *   tree[0] = leaves (sorted)
 *   tree[1] = first level of internal nodes
 *   ...
 *   tree[tree.length - 1] = [root]
 *
 * Leaves are sorted before building to ensure determinism.
 */
export function buildTree(leaves: string[]): string[][] {
  if (leaves.length === 0) {
    return [[`0x${"0".repeat(64)}`]]; // empty tree → zero root
  }

  // Sort leaves for deterministic construction
  const sorted = [...leaves].sort((a, b) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  );

  const tree: string[][] = [sorted];
  let currentLevel = sorted;

  while (currentLevel.length > 1) {
    const nextLevel: string[] = [];
    for (let i = 0; i < currentLevel.length; i += 2) {
      if (i + 1 < currentLevel.length) {
        nextLevel.push(hashPair(currentLevel[i], currentLevel[i + 1]));
      } else {
        // Odd node: promote to next level (no sibling)
        nextLevel.push(currentLevel[i]);
      }
    }
    tree.push(nextLevel);
    currentLevel = nextLevel;
  }

  return tree;
}

/**
 * Get the proof (sibling path) for a leaf in the tree.
 */
export function getProof(tree: string[][], leaf: string): string[] {
  const proof: string[] = [];
  let index = tree[0].indexOf(leaf);

  if (index === -1) return []; // leaf not in tree

  for (let level = 0; level < tree.length - 1; level++) {
    const currentLevel = tree[level];
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;

    if (siblingIndex < currentLevel.length) {
      proof.push(currentLevel[siblingIndex]);
    }

    index = Math.floor(index / 2);
  }

  return proof;
}

/**
 * Get the root of the tree.
 */
export function getRoot(tree: string[][]): string {
  return tree[tree.length - 1][0];
}

/**
 * Verify a proof against a root.
 *
 * Recomputes the root from the leaf + proof path and checks
 * if it matches the expected root.
 */
export function verifyProof(
  leaf: string,
  proof: string[],
  expectedRoot: string,
): boolean {
  let computed = leaf;
  for (const sibling of proof) {
    computed = hashPair(computed, sibling);
  }
  return computed.toLowerCase() === expectedRoot.toLowerCase();
}

// ── High-level API ───────────────────────────────────────────────────────

/**
 * Build a Merkle tree from the current whitelist.
 *
 * Reads all verified addresses from whitelist.json, hashes them into
 * leaves, and builds the tree.
 */
export function buildWhitelistTree(): {
  tree: string[][];
  info: MerkleTreeInfo;
} {
  const addresses = getVerifiedAddresses();
  const leaves = addresses.map((addr) => hashLeaf(addr));

  const tree = buildTree(leaves);
  const root = getRoot(tree);

  logger.info(
    `[merkle] Built whitelist tree with ${addresses.length} addresses (root: ${root.slice(0, 10)}...)`,
  );

  return {
    tree,
    info: {
      root,
      addressCount: addresses.length,
      leaves: tree[0],
    },
  };
}

/**
 * Generate a Merkle proof for a specific address.
 *
 * Returns the proof, leaf, root, and whether the address is whitelisted.
 * The proof can be passed directly to `mintWhitelist()` on the contract.
 */
export function generateProof(walletAddress: string): MerkleProofResult {
  const { tree, info } = buildWhitelistTree();

  let leaf: string;
  try {
    leaf = hashLeaf(walletAddress);
  } catch {
    return {
      proof: [],
      leaf: `0x${"0".repeat(64)}`,
      root: info.root,
      isWhitelisted: false,
    };
  }

  const proof = getProof(tree, leaf);
  const isWhitelisted =
    proof.length > 0 || (info.addressCount === 1 && tree[0][0] === leaf);

  if (isWhitelisted) {
    const valid = verifyProof(leaf, proof, info.root);
    if (!valid) {
      logger.warn(
        `[merkle] Proof verification failed for ${walletAddress} — tree may be corrupted`,
      );
      return { proof: [], leaf, root: info.root, isWhitelisted: false };
    }
  }

  return { proof, leaf, root: info.root, isWhitelisted };
}

/**
 * `tree.aria` — pure operations over Playwright ARIA-snapshot YAML, used as the
 * "computed HTML tree printout" artifact (kind `html-tree`). Producers capture
 * the snapshot elsewhere via `page.ariaSnapshot()`; this package never depends
 * on Playwright — it only normalizes, diffs, and prunes the captured YAML so a
 * checked-in tree is stable across runs and structural regressions surface as a
 * concrete add/remove/change list rather than a raw-DOM noise diff.
 *
 * The snapshot format is Playwright's indentation-based YAML-ish tree: each line
 * is `- <role> "<name>"` with optional trailing attributes, nesting encoded by
 * leading spaces. We parse it into a tree of nodes, which is enough for stable
 * ordering, structural diffing, and depth/role pruning without a YAML library.
 */

import type { Analyzer, AnalyzerFragment, AnalyzerInput } from "./types.ts";

/** One node in a parsed ARIA snapshot tree. */
export interface AriaNode {
  role: string;
  name?: string;
  /** Trailing attributes like `[checked]`, `[level=2]`, preserved verbatim. */
  attributes: string[];
  children: AriaNode[];
}

/** Parse Playwright ARIA-snapshot YAML into a node tree (indentation = depth). */
export function parseAriaSnapshot(yaml: string): AriaNode[] {
  const root: AriaNode = { role: "__root__", attributes: [], children: [] };
  // Stack of (indent, node); children attach to the nearest shallower node.
  const stack: { indent: number; node: AriaNode }[] = [
    { indent: -1, node: root },
  ];
  for (const rawLine of yaml.split("\n")) {
    if (rawLine.trim() === "") continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    const node = parseLine(rawLine.trim());
    if (!node) continue;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
      stack.pop();
    }
    stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
  }
  return root.children;
}

/** Parse one snapshot line body (`- button "Save" [disabled]`) into a node. */
function parseLine(body: string): AriaNode | null {
  let rest = body.startsWith("- ") ? body.slice(2) : body;
  rest = rest.trim();
  if (rest === "") return null;
  const attributes: string[] = [];
  // Pull trailing `[...]` attribute groups off the end.
  let attrMatch = rest.match(/\s(\[[^\]]*\])\s*$/);
  while (attrMatch) {
    attributes.unshift(attrMatch[1]);
    rest = rest.slice(0, attrMatch.index).trimEnd();
    attrMatch = rest.match(/\s(\[[^\]]*\])\s*$/);
  }
  // Optional accessible name in double quotes.
  const nameMatch = rest.match(/^(\S+)\s+"([^"]*)"\s*$/);
  if (nameMatch) {
    return {
      role: nameMatch[1],
      name: nameMatch[2],
      attributes,
      children: [],
    };
  }
  // Role, and a trailing `:` on container lines is dropped.
  const role = rest.replace(/:\s*$/, "").trim();
  return { role, attributes, children: [] };
}

/**
 * Normalize a snapshot to a stable string: trimmed lines, sorted attribute
 * groups within a node, and sibling order made deterministic by sorting on a
 * node's own key (role + name + attrs) while preserving subtree shape. Two
 * captures of the same UI that differ only in incidental sibling ordering or
 * whitespace normalize to identical text.
 */
export function normalizeAriaSnapshot(yaml: string): string {
  const tree = parseAriaSnapshot(yaml);
  sortTree(tree);
  return renderTree(tree, 0).join("\n");
}

function sortTree(nodes: AriaNode[]): void {
  for (const node of nodes) {
    node.attributes.sort();
    sortTree(node.children);
  }
  nodes.sort((a, b) => nodeKey(a).localeCompare(nodeKey(b)));
}

function nodeKey(node: AriaNode): string {
  return `${node.role}\u0000${node.name ?? ""}\u0000${node.attributes.join(",")}`;
}

function renderTree(nodes: AriaNode[], depth: number): string[] {
  const lines: string[] = [];
  const pad = "  ".repeat(depth);
  for (const node of nodes) {
    const parts = [`- ${node.role}`];
    if (node.name !== undefined) parts.push(`"${node.name}"`);
    for (const attr of node.attributes) parts.push(attr);
    lines.push(pad + parts.join(" "));
    lines.push(...renderTree(node.children, depth + 1));
  }
  return lines;
}

/** One structural difference between two snapshots. */
export interface AriaDiffEntry {
  kind: "added" | "removed" | "changed";
  /** Slash-joined role path to the node, e.g. `main/list/listitem`. */
  path: string;
  detail: string;
}

/**
 * Structural diff of two snapshots. Nodes are matched positionally within a
 * parent by role sequence; a role present in one but not the other is
 * added/removed, and a matched node whose name or attributes differ is changed.
 * Produces a flat, reviewable list rather than a character diff.
 */
export function diffAriaSnapshots(a: string, b: string): AriaDiffEntry[] {
  const diffs: AriaDiffEntry[] = [];
  walkDiff(parseAriaSnapshot(a), parseAriaSnapshot(b), "", diffs);
  return diffs;
}

function walkDiff(
  before: AriaNode[],
  after: AriaNode[],
  parentPath: string,
  out: AriaDiffEntry[],
): void {
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    const b = before[i];
    const a = after[i];
    const path = `${parentPath}${a?.role ?? b?.role ?? "?"}`;
    if (b && !a) {
      out.push({ kind: "removed", path, detail: describe(b) });
      continue;
    }
    if (a && !b) {
      out.push({ kind: "added", path, detail: describe(a) });
      continue;
    }
    if (a && b) {
      if (a.role !== b.role || a.name !== b.name || !sameAttrs(a, b)) {
        out.push({
          kind: "changed",
          path,
          detail: `${describe(b)} → ${describe(a)}`,
        });
      }
      walkDiff(b.children, a.children, `${path}/`, out);
    }
  }
}

function sameAttrs(a: AriaNode, b: AriaNode): boolean {
  if (a.attributes.length !== b.attributes.length) return false;
  const sa = [...a.attributes].sort();
  const sb = [...b.attributes].sort();
  return sa.every((v, i) => v === sb[i]);
}

function describe(node: AriaNode): string {
  const parts = [node.role];
  if (node.name !== undefined) parts.push(`"${node.name}"`);
  if (node.attributes.length) parts.push(node.attributes.join(""));
  return parts.join(" ");
}

/** Options for {@link pruneAriaSnapshot}. */
export interface PruneOptions {
  /** Drop nodes deeper than this depth (root nodes are depth 0). */
  maxDepth?: number;
  /** Roles to drop entirely (with their subtrees). */
  dropRoles?: string[];
}

/**
 * Prune a snapshot to a smaller, stabler tree: cut below `maxDepth` and remove
 * whole subtrees for `dropRoles`. Returns re-rendered YAML preserving the
 * remaining structure, for a compact checked-in artifact.
 */
export function pruneAriaSnapshot(yaml: string, options: PruneOptions): string {
  const drop = new Set(options.dropRoles ?? []);
  const prune = (nodes: AriaNode[], depth: number): AriaNode[] =>
    nodes
      .filter((node) => !drop.has(node.role))
      .map((node) => ({
        ...node,
        children:
          options.maxDepth !== undefined && depth >= options.maxDepth
            ? []
            : prune(node.children, depth + 1),
      }));
  return renderTree(prune(parseAriaSnapshot(yaml), 0), 0).join("\n");
}

/** Payload of a `ran` `tree.aria` result. */
export interface AriaTreeData {
  /** Node count in the parsed tree, a cheap stability signal. */
  nodes: number;
  normalized: string;
}

/**
 * Runner-facing analyzer: reads a captured snapshot artifact and records its
 * normalized form and node count. Diff/prune are exported as pure utilities for
 * the checked-in-snapshot comparison the consumer does with a baseline.
 */
export const ariaTreeAnalyzer: Analyzer = {
  name: "tree.aria",
  tier: "cpu",
  kinds: ["html-tree"],
  async analyze(input: AnalyzerInput): Promise<AnalyzerFragment> {
    const { readFile } = await import("node:fs/promises");
    const yaml = await readFile(input.absolutePath, "utf8");
    const tree = parseAriaSnapshot(yaml);
    const data: AriaTreeData = {
      nodes: countNodes(tree),
      normalized: normalizeAriaSnapshot(yaml),
    };
    return { status: "ran", data };
  },
};

function countNodes(nodes: AriaNode[]): number {
  return nodes.reduce((sum, node) => sum + 1 + countNodes(node.children), 0);
}

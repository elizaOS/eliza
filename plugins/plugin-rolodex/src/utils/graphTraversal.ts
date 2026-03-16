/**
 * Graph traversal utilities for the entity relationship graph.
 *
 * Operates on an adjacency-list representation built from the
 * runtime's relationship data. All traversals are bounded to
 * prevent runaway computation on large graphs.
 */

import type { UUID, Relationship } from '@elizaos/core';

/**
 * An adjacency-list graph built from relationships.
 * Maps entityId -> Set of connected entityIds.
 */
export type AdjacencyGraph = Map<UUID, Set<UUID>>;

/**
 * Build an adjacency graph from a list of relationships.
 * Relationships are treated as undirected edges.
 */
export function buildAdjacencyGraph(relationships: Relationship[]): AdjacencyGraph {
  const graph: AdjacencyGraph = new Map();

  for (const rel of relationships) {
    const a = rel.sourceEntityId;
    const b = rel.targetEntityId;

    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());

    graph.get(a)!.add(b);
    graph.get(b)!.add(a);
  }

  return graph;
}

/**
 * Get the N-hop neighborhood of an entity.
 *
 * This is the key operation for small-world entity resolution: instead
 * of scanning all entities, we only compare against entities within
 * a few hops. In small-world networks, 2-3 hops covers the relevant
 * local cluster.
 *
 * @param graph  The adjacency graph.
 * @param start  The starting entity.
 * @param hops   Maximum number of hops (default 2).
 * @param maxNodes Maximum nodes to return (safety bound, default 200).
 * @returns Set of entity IDs within the neighborhood (excluding start).
 */
export function getNeighborhood(
  graph: AdjacencyGraph,
  start: UUID,
  hops: number = 2,
  maxNodes: number = 200
): Set<UUID> {
  const visited = new Set<UUID>();
  const queue: Array<{ node: UUID; depth: number }> = [{ node: start, depth: 0 }];
  visited.add(start);

  while (queue.length > 0 && visited.size <= maxNodes) {
    const { node, depth } = queue.shift()!;

    if (depth >= hops) continue;

    const neighbors = graph.get(node);
    if (!neighbors) continue;

    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push({ node: neighbor, depth: depth + 1 });
        if (visited.size > maxNodes) break;
      }
    }
  }

  // Remove the starting node from the result
  visited.delete(start);
  return visited;
}

/**
 * Find the shortest path between two entities using BFS.
 *
 * @returns Array of entity IDs forming the path, or null if no path exists.
 *          Includes both start and end.
 */
export function shortestPath(
  graph: AdjacencyGraph,
  start: UUID,
  end: UUID,
  maxDepth: number = 10
): UUID[] | null {
  if (start === end) return [start];

  const visited = new Set<UUID>();
  const parent = new Map<UUID, UUID>();
  const queue: Array<{ node: UUID; depth: number }> = [{ node: start, depth: 0 }];
  visited.add(start);

  while (queue.length > 0) {
    const { node, depth } = queue.shift()!;

    if (depth >= maxDepth) continue;

    const neighbors = graph.get(node);
    if (!neighbors) continue;

    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;

      visited.add(neighbor);
      parent.set(neighbor, node);

      if (neighbor === end) {
        // Reconstruct path
        const path: UUID[] = [end];
        let current = end;
        while (parent.has(current)) {
          current = parent.get(current)!;
          path.unshift(current);
        }
        return path;
      }

      queue.push({ node: neighbor, depth: depth + 1 });
    }
  }

  return null;
}

/**
 * Get shared connections between two entities.
 *
 * @returns Set of entity IDs that are directly connected to both A and B.
 */
export function sharedConnections(graph: AdjacencyGraph, entityA: UUID, entityB: UUID): Set<UUID> {
  const neighborsA = graph.get(entityA);
  const neighborsB = graph.get(entityB);

  if (!neighborsA || !neighborsB) return new Set();

  const shared = new Set<UUID>();
  for (const n of neighborsA) {
    if (neighborsB.has(n)) shared.add(n);
  }
  return shared;
}

/**
 * Compute degree centrality for all nodes (number of direct connections).
 * Returns nodes sorted by degree descending.
 */
export function degreeCentrality(graph: AdjacencyGraph): Array<{ entityId: UUID; degree: number }> {
  const result: Array<{ entityId: UUID; degree: number }> = [];

  for (const [entityId, neighbors] of graph) {
    result.push({ entityId, degree: neighbors.size });
  }

  return result.sort((a, b) => b.degree - a.degree);
}

/**
 * Detect clusters / communities using a simple label propagation approach.
 *
 * Each node starts with its own label. In each iteration, nodes adopt the
 * most common label among their neighbors. Converges when labels stabilize.
 *
 * This is O(V + E) per iteration and typically converges in 3-5 iterations
 * for small-world graphs.
 *
 * @param graph     The adjacency graph.
 * @param maxIter   Maximum iterations (default 10).
 * @returns Map of entityId -> clusterId.
 */
export function detectClusters(graph: AdjacencyGraph, maxIter: number = 10): Map<UUID, string> {
  // Initialize: each node is its own cluster
  const labels = new Map<UUID, string>();
  const nodes = Array.from(graph.keys());
  for (const node of nodes) {
    labels.set(node, node);
  }

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;

    // Shuffle nodes to avoid order bias
    const shuffled = [...nodes].sort(() => Math.random() - 0.5);

    for (const node of shuffled) {
      const neighbors = graph.get(node);
      if (!neighbors || neighbors.size === 0) continue;

      // Count neighbor labels
      const labelCounts = new Map<string, number>();
      for (const neighbor of neighbors) {
        const label = labels.get(neighbor) ?? neighbor;
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }

      // Pick the most common label
      let bestLabel = labels.get(node)!;
      let bestCount = 0;
      for (const [label, count] of labelCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestLabel = label;
        }
      }

      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  return labels;
}

/**
 * Get all entities in the same cluster as the given entity.
 */
export function getClusterMembers(clusters: Map<UUID, string>, entityId: UUID): UUID[] {
  const clusterId = clusters.get(entityId);
  if (!clusterId) return [];

  const members: UUID[] = [];
  for (const [id, label] of clusters) {
    if (label === clusterId) members.push(id);
  }
  return members;
}

/**
 * Compute a simple "influence score" for an entity based on:
 *  - Degree centrality (how many connections)
 *  - Betweenness approximation (how many shortest paths pass through)
 *
 * The betweenness is approximated by sampling rather than computing
 * all-pairs shortest paths (which is O(V^3)).
 *
 * @param graph      The adjacency graph.
 * @param entityId   The entity to score.
 * @param sampleSize Number of random pairs to sample for betweenness.
 * @returns Influence score 0-1.
 */
export function influenceScore(
  graph: AdjacencyGraph,
  entityId: UUID,
  sampleSize: number = 50
): number {
  const nodes = Array.from(graph.keys());
  if (nodes.length < 3) return 0;

  // Degree component (0-0.5)
  const degree = graph.get(entityId)?.size ?? 0;
  const maxDegree = Math.max(...Array.from(graph.values()).map((s) => s.size));
  const degreeScore = maxDegree > 0 ? (degree / maxDegree) * 0.5 : 0;

  // Betweenness approximation (0-0.5)
  let pathsThrough = 0;
  let totalPaths = 0;

  for (let i = 0; i < sampleSize; i++) {
    const a = nodes[Math.floor(Math.random() * nodes.length)];
    const b = nodes[Math.floor(Math.random() * nodes.length)];

    if (a === b || a === entityId || b === entityId) continue;

    const path = shortestPath(graph, a, b, 6);
    if (path) {
      totalPaths++;
      if (path.includes(entityId)) pathsThrough++;
    }
  }

  const betweennessScore = totalPaths > 0 ? (pathsThrough / totalPaths) * 0.5 : 0;

  return Math.min(1, degreeScore + betweennessScore);
}

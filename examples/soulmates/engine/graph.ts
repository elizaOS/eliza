import type { MatchGraph, MatchGraphEdge, PersonaId } from "./types";
import { clampNumber, unique } from "./utils";

export type GraphAdjacency = Record<string, MatchGraphEdge[]>;

const edgeWeight = (edge: MatchGraphEdge): number => {
  const multipliers = {
    feedback_positive: 1.2,
    feedback_negative: 0.6,
    met: 1.1,
    match: 1,
  };
  return edge.weight * (multipliers[edge.type] ?? 1);
};

export const buildAdjacency = (graph: MatchGraph): GraphAdjacency => {
  const adjacency: GraphAdjacency = {};
  for (const edge of graph.edges) {
    const fromKey = String(edge.from);
    const toKey = String(edge.to);
    adjacency[fromKey] = adjacency[fromKey] ?? [];
    adjacency[toKey] = adjacency[toKey] ?? [];
    adjacency[fromKey].push(edge);
    adjacency[toKey].push({ ...edge, from: edge.to, to: edge.from });
  }
  return adjacency;
};

export const expandGraphCandidates = (
  personaId: PersonaId,
  adjacency: GraphAdjacency,
  hops: number,
  maxCandidates: number,
): PersonaId[] => {
  if (hops <= 0) {
    return [];
  }
  const visited = new Set<string>([String(personaId)]);
  let frontier = [String(personaId)];
  const scored: Array<{ id: PersonaId; score: number }> = [];

  for (let hop = 0; hop < hops; hop += 1) {
    const nextFrontier: string[] = [];
    for (const node of frontier) {
      const edges = adjacency[node] ?? [];
      for (const edge of edges) {
        const toKey = String(edge.to);
        if (visited.has(toKey)) {
          continue;
        }
        visited.add(toKey);
        nextFrontier.push(toKey);
        scored.push({ id: edge.to, score: edgeWeight(edge) / (hop + 1) });
      }
    }
    frontier = nextFrontier;
  }

  scored.sort((a, b) => b.score - a.score);
  const ordered = unique(scored.map((item) => item.id));
  return ordered.slice(0, Math.max(0, maxCandidates));
};

export const addGraphEdge = (
  graph: MatchGraph,
  edge: MatchGraphEdge,
  maxEdges: number = 5000,
): void => {
  graph.edges.push(edge);
  if (graph.edges.length > maxEdges) {
    graph.edges = graph.edges.slice(graph.edges.length - maxEdges);
  }
};

export const normalizeGraphWeights = (graph: MatchGraph): void => {
  if (graph.edges.length === 0) {
    return;
  }
  const maxWeight = Math.max(...graph.edges.map((edge) => edge.weight));
  if (maxWeight <= 0) {
    return;
  }
  for (const edge of graph.edges) {
    edge.weight = clampNumber(edge.weight / maxWeight, 0, 1);
  }
};

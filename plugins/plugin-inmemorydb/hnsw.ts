import type { IVectorStorage, VectorSearchResult } from "./types";

interface HNSWNode {
  id: string;
  vector: number[];
  level: number;
  neighbors: Map<number, Set<string>>;
}

interface HNSWConfig {
  M: number;
  efConstruction: number;
  efSearch: number;
  mL: number;
}

function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
  if (magnitude === 0) return 1;

  return 1 - dotProduct / magnitude;
}

export class EphemeralHNSW implements IVectorStorage {
  private nodes: Map<string, HNSWNode> = new Map();
  private entryPoint: string | null = null;
  private maxLevel = 0;
  private dimension = 0;
  private config: HNSWConfig;

  constructor() {
    this.config = {
      M: 16,
      efConstruction: 200,
      efSearch: 50,
      mL: 1 / Math.log(16),
    };
  }

  async init(dimension: number): Promise<void> {
    this.dimension = dimension;
  }

  private getRandomLevel(): number {
    let level = 0;
    while (Math.random() < Math.exp(-level * this.config.mL) && level < 16) {
      level++;
    }
    return level;
  }

  async add(id: string, vector: number[]): Promise<void> {
    if (vector.length !== this.dimension) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.dimension}, got ${vector.length}`
      );
    }

    const existing = this.nodes.get(id);
    if (existing) {
      existing.vector = vector;
      return;
    }

    const level = this.getRandomLevel();
    const newNode: HNSWNode = {
      id,
      vector,
      level,
      neighbors: new Map(),
    };

    for (let l = 0; l <= level; l++) {
      newNode.neighbors.set(l, new Set());
    }

    if (this.entryPoint === null) {
      this.entryPoint = id;
      this.maxLevel = level;
      this.nodes.set(id, newNode);
      return;
    }

    let currentNode = this.entryPoint;

    for (let l = this.maxLevel; l > level; l--) {
      currentNode = this.searchLayer(vector, currentNode, 1, l)[0]?.id ?? currentNode;
    }

    for (let l = Math.min(level, this.maxLevel); l >= 0; l--) {
      const neighbors = this.searchLayer(vector, currentNode, this.config.efConstruction, l);

      const M = this.config.M;
      const selectedNeighbors = neighbors.slice(0, M);

      for (const neighbor of selectedNeighbors) {
        const neighborSet = newNode.neighbors.get(l);
        if (neighborSet) {
          neighborSet.add(neighbor.id);
        }

        const neighborNode = this.nodes.get(neighbor.id);
        if (neighborNode) {
          let neighborSet = neighborNode.neighbors.get(l);
          if (!neighborSet) {
            neighborSet = new Set();
            neighborNode.neighbors.set(l, neighborSet);
          }
          neighborSet.add(id);

          if (neighborSet.size > M) {
            const toKeep = this.selectBestNeighbors(neighborNode.vector, neighborSet, M);
            neighborNode.neighbors.set(l, new Set(toKeep.map((n) => n.id)));
          }
        }
      }

      if (neighbors.length > 0) {
        currentNode = neighbors[0].id;
      }
    }

    this.nodes.set(id, newNode);

    if (level > this.maxLevel) {
      this.maxLevel = level;
      this.entryPoint = id;
    }
  }

  private searchLayer(
    query: number[],
    entryId: string,
    ef: number,
    level: number
  ): Array<{ id: string; distance: number }> {
    const visited = new Set<string>([entryId]);
    const entryNode = this.nodes.get(entryId);
    if (!entryNode) return [];

    const entryDist = cosineDistance(query, entryNode.vector);

    const candidates: Array<{ id: string; distance: number }> = [
      { id: entryId, distance: entryDist },
    ];

    const results: Array<{ id: string; distance: number }> = [{ id: entryId, distance: entryDist }];

    while (candidates.length > 0) {
      candidates.sort((a, b) => a.distance - b.distance);
      const current = candidates.shift();
      if (!current) break;

      results.sort((a, b) => b.distance - a.distance);
      const furthestResult = results[0];

      if (current.distance > furthestResult.distance) {
        break;
      }

      const currentNode = this.nodes.get(current.id);
      if (!currentNode) continue;

      const neighbors = currentNode.neighbors.get(level);
      if (!neighbors) continue;

      for (const neighborId of neighbors) {
        if (visited.has(neighborId)) continue;
        visited.add(neighborId);

        const neighborNode = this.nodes.get(neighborId);
        if (!neighborNode) continue;

        const dist = cosineDistance(query, neighborNode.vector);

        if (results.length < ef || dist < furthestResult.distance) {
          candidates.push({ id: neighborId, distance: dist });
          results.push({ id: neighborId, distance: dist });

          if (results.length > ef) {
            results.sort((a, b) => b.distance - a.distance);
            results.pop();
          }
        }
      }
    }

    results.sort((a, b) => a.distance - b.distance);
    return results;
  }

  private selectBestNeighbors(
    nodeVector: number[],
    neighborIds: Set<string>,
    M: number
  ): Array<{ id: string; distance: number }> {
    const neighbors: Array<{ id: string; distance: number }> = [];

    for (const id of neighborIds) {
      const node = this.nodes.get(id);
      if (node) {
        neighbors.push({
          id,
          distance: cosineDistance(nodeVector, node.vector),
        });
      }
    }

    neighbors.sort((a, b) => a.distance - b.distance);
    return neighbors.slice(0, M);
  }

  async remove(id: string): Promise<void> {
    const node = this.nodes.get(id);
    if (!node) return;

    for (const [level, neighbors] of node.neighbors) {
      for (const neighborId of neighbors) {
        const neighborNode = this.nodes.get(neighborId);
        if (neighborNode) {
          neighborNode.neighbors.get(level)?.delete(id);
        }
      }
    }

    this.nodes.delete(id);

    if (this.entryPoint === id) {
      if (this.nodes.size === 0) {
        this.entryPoint = null;
        this.maxLevel = 0;
      } else {
        let maxLevel = 0;
        let newEntry: string | null = null;
        for (const [nodeId, n] of this.nodes) {
          if (n.level >= maxLevel) {
            maxLevel = n.level;
            newEntry = nodeId;
          }
        }
        this.entryPoint = newEntry;
        this.maxLevel = maxLevel;
      }
    }
  }

  async search(query: number[], k: number, threshold = 0.5): Promise<VectorSearchResult[]> {
    if (this.entryPoint === null || this.nodes.size === 0) {
      return [];
    }

    if (query.length !== this.dimension) {
      throw new Error(`Query dimension mismatch: expected ${this.dimension}, got ${query.length}`);
    }

    let currentNode = this.entryPoint;

    for (let l = this.maxLevel; l > 0; l--) {
      const closest = this.searchLayer(query, currentNode, 1, l);
      if (closest.length > 0) {
        currentNode = closest[0].id;
      }
    }

    const results = this.searchLayer(query, currentNode, Math.max(k, this.config.efSearch), 0);

    return results
      .slice(0, k)
      .filter((r) => 1 - r.distance >= threshold)
      .map((r) => ({
        id: r.id,
        distance: r.distance,
        similarity: 1 - r.distance,
      }));
  }

  async clear(): Promise<void> {
    this.nodes.clear();
    this.entryPoint = null;
    this.maxLevel = 0;
  }

  size(): number {
    return this.nodes.size;
  }
}

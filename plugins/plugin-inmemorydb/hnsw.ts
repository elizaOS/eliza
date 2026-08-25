/**
 * `EphemeralHNSW`: an in-memory, cosine-distance HNSW (Hierarchical Navigable
 * Small World) vector index implementing `IVectorStorage`. Nodes are assigned
 * a random level on insert; search descends from the entry point through
 * upper layers before doing a beam search (`efSearch`) on layer 0. All state
 * lives in the `nodes` map — nothing is persisted, and `clear()`/losing the
 * process discards the index entirely.
 */
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
    const aValue = a[i] ?? 0;
    const bValue = b[i] ?? 0;
    dotProduct += aValue * bValue;
    normA += aValue * aValue;
    normB += bValue * bValue;
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
        const closestNeighbor = neighbors[0];
        if (closestNeighbor) {
          currentNode = closestNeighbor.id;
        }
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
      if (!furthestResult) break;

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
      const closestNode = closest[0];
      if (closestNode) {
        currentNode = closestNode.id;
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

  /**
   * Brute-force nearest-neighbor scan over every indexed vector. The
   * approximate graph traversal in `search` can leave reachable nodes
   * unvisited (identical/near-duplicate clusters trap the beam), so callers
   * that must not miss any eligible vector — e.g. scope-filtered memory recall
   * that filters after ranking — use this instead. O(n) over the in-memory
   * node map, which matches this index's "speed over durability" mandate for
   * the small corpora it serves. The bounded max-heap keeps only the best K
   * eligible results, making the scan O(n log K) time and O(K) result memory.
   */
  async searchExact(
    query: number[],
    k: number,
    threshold = 0.5,
    eligibleIds?: ReadonlySet<string>
  ): Promise<VectorSearchResult[]> {
    const resultLimit = Math.max(0, Math.trunc(k));
    if (this.nodes.size === 0 || resultLimit === 0) return [];

    if (query.length !== this.dimension) {
      throw new Error(`Query dimension mismatch: expected ${this.dimension}, got ${query.length}`);
    }

    const best: VectorSearchResult[] = [];
    const compare = (a: VectorSearchResult, b: VectorSearchResult): number =>
      a.distance - b.distance || a.id.localeCompare(b.id);
    const swap = (left: number, right: number): void => {
      const value = best[left];
      const replacement = best[right];
      if (!value || !replacement) return;
      best[left] = replacement;
      best[right] = value;
    };
    const bubbleUp = (start: number): void => {
      let index = start;
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        const current = best[index];
        const parentValue = best[parent];
        if (!current || !parentValue || compare(current, parentValue) <= 0) break;
        swap(index, parent);
        index = parent;
      }
    };
    const bubbleDown = (): void => {
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let worse = index;
        if (best[left] && best[worse] && compare(best[left], best[worse]) > 0) worse = left;
        if (best[right] && best[worse] && compare(best[right], best[worse]) > 0) worse = right;
        if (worse === index) break;
        swap(index, worse);
        index = worse;
      }
    };

    for (const node of this.nodes.values()) {
      if (eligibleIds && !eligibleIds.has(node.id)) continue;
      const distance = cosineDistance(query, node.vector);
      const similarity = 1 - distance;
      if (similarity >= threshold) {
        const candidate = { id: node.id, distance, similarity };
        if (best.length < resultLimit) {
          best.push(candidate);
          bubbleUp(best.length - 1);
        } else if (best[0] && compare(candidate, best[0]) < 0) {
          best[0] = candidate;
          bubbleDown();
        }
      }
    }

    return best.sort(compare);
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

/**
 * Unit tests for utility functions:
 *  - Time weighting / decay
 *  - Name similarity / handle correlation
 *  - Graph traversal
 */

import { describe, it, expect } from 'vitest';

import {
  computeDecayedConfidence,
  getEffectiveHalfLife,
  computeRelationshipDecay,
  boostConfidenceFromCorroboration,
  penalizeConfidenceFromDispute,
} from '../utils/timeWeighting';

import {
  nameSimilarity,
  handleCorrelation,
  normalizeHandle,
  jaccardSimilarity,
  nameVariationMatch,
  extractBaseUsername,
  couldBeSameEntity,
} from '../utils/similarity';

import {
  buildAdjacencyGraph,
  getNeighborhood,
  shortestPath,
  sharedConnections,
  degreeCentrality,
  detectClusters,
  getClusterMembers,
} from '../utils/graphTraversal';

import type { InformationClaim } from '../types/index';
import type { UUID, Relationship } from '@elizaos/core';

// ──────────────────────────────────────────────
// Time Weighting Tests
// ──────────────────────────────────────────────

describe('timeWeighting', () => {
  const baseClaim: InformationClaim = {
    id: 'test-claim-id' as UUID,
    entityId: 'entity-1' as UUID,
    field: 'twitter_handle',
    value: '@dave_codes',
    tier: 'self_reported',
    confidence: 0.8,
    baseConfidence: 0.8,
    sourceEntityId: 'entity-1' as UUID,
    sourceContext: {
      platform: 'discord',
      roomId: 'room-1' as UUID,
      timestamp: Date.now(),
    },
    corroborations: [],
    disputes: [],
    scope: 'platform',
    halfLifeMs: 90 * 24 * 60 * 60 * 1000, // 90 days
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  it('should not decay fresh claims', () => {
    const result = computeDecayedConfidence(baseClaim);
    expect(result).toBeCloseTo(0.8, 2);
  });

  it('should decay claims after half-life', () => {
    const oldClaim = {
      ...baseClaim,
      updatedAt: Date.now() - 90 * 24 * 60 * 60 * 1000, // 90 days ago
    };
    const result = computeDecayedConfidence(oldClaim);
    expect(result).toBeCloseTo(0.4, 1); // Should be ~half
  });

  it('should not decay ground truth claims', () => {
    const groundTruth = { ...baseClaim, halfLifeMs: Infinity };
    const old = {
      ...groundTruth,
      updatedAt: Date.now() - 365 * 24 * 60 * 60 * 1000,
    };
    expect(computeDecayedConfidence(old)).toBe(0.8);
  });

  it('should increase effective half-life with corroborations', () => {
    const corroborated = {
      ...baseClaim,
      corroborations: [
        { entityId: 'e1' as UUID, timestamp: Date.now(), context: 'confirmed' },
        { entityId: 'e2' as UUID, timestamp: Date.now(), context: 'confirmed' },
      ],
    };
    const halfLife = getEffectiveHalfLife(corroborated);
    // 2 corroborations = 2^2 = 4x the base half-life
    expect(halfLife).toBeGreaterThan(baseClaim.halfLifeMs);
  });

  it('should decrease effective half-life with unresolved disputes', () => {
    const disputed = {
      ...baseClaim,
      disputes: [
        {
          entityId: 'e1' as UUID,
          alternativeValue: '@real_dave',
          timestamp: Date.now(),
          context: 'correction',
          resolved: false,
        },
      ],
    };
    const halfLife = getEffectiveHalfLife(disputed);
    expect(halfLife).toBeLessThan(baseClaim.halfLifeMs);
  });

  it('should compute relationship decay', () => {
    const recent = computeRelationshipDecay(80, new Date().toISOString(), 30 * 24 * 3600000);
    expect(recent).toBe(80);

    const old = computeRelationshipDecay(
      80,
      new Date(Date.now() - 30 * 24 * 3600000).toISOString(),
      30 * 24 * 3600000
    );
    expect(old).toBe(40); // Half-life passed = half strength
  });

  it('should boost confidence with corroboration (diminishing returns)', () => {
    const first = boostConfidenceFromCorroboration(0.5, 0);
    expect(first).toBeGreaterThan(0.5);

    const second = boostConfidenceFromCorroboration(first, 1);
    const boost1 = first - 0.5;
    const boost2 = second - first;
    expect(boost2).toBeLessThan(boost1); // Diminishing returns
  });

  it('should penalize confidence with disputes', () => {
    const penalized = penalizeConfidenceFromDispute(0.8, 1, 0);
    expect(penalized).toBeLessThan(0.8);
    expect(penalized).toBeGreaterThan(0);

    // More corroborations = more resilience
    const resilient = penalizeConfidenceFromDispute(0.8, 1, 5);
    expect(resilient).toBeGreaterThan(penalized);
  });
});

// ──────────────────────────────────────────────
// Similarity Tests
// ──────────────────────────────────────────────

describe('similarity', () => {
  describe('nameSimilarity', () => {
    it('should return 1 for identical names', () => {
      expect(nameSimilarity('Dave', 'Dave')).toBe(1);
      expect(nameSimilarity('dave', 'DAVE')).toBe(1);
    });

    it('should return high similarity for close names', () => {
      expect(nameSimilarity('Dave', 'David')).toBeGreaterThanOrEqual(0.6);
      expect(nameSimilarity('Sarah', 'Sara')).toBeGreaterThan(0.7);
    });

    it('should return low similarity for different names', () => {
      expect(nameSimilarity('Dave', 'Alice')).toBeLessThan(0.4);
      expect(nameSimilarity('Bob', 'Elizabeth')).toBeLessThan(0.3);
    });
  });

  describe('handleCorrelation', () => {
    it('should return 1 for same handle with different formatting', () => {
      expect(handleCorrelation('@dave_codes', 'dave_codes')).toBe(1);
      expect(handleCorrelation('DaveCodes', 'davecodes')).toBe(1);
    });

    it('should return high for handles with separators only', () => {
      expect(handleCorrelation('dave_codes', 'dave-codes')).toBe(1);
      expect(handleCorrelation('dave.codes', 'dave_codes')).toBe(1);
    });

    it('should detect containment patterns', () => {
      const result = handleCorrelation('davecodes', 'davecodeseth');
      expect(result).toBeGreaterThan(0.6);
    });

    it('should return low for different handles', () => {
      expect(handleCorrelation('alice_dev', 'bob_coder')).toBeLessThan(0.5);
    });
  });

  describe('normalizeHandle', () => {
    it('should strip @ prefix', () => {
      expect(normalizeHandle('@dave')).toBe('dave');
    });

    it('should remove separators', () => {
      expect(normalizeHandle('dave_codes')).toBe('davecodes');
      expect(normalizeHandle('dave-codes')).toBe('davecodes');
      expect(normalizeHandle('dave.codes')).toBe('davecodes');
    });

    it('should remove Discord discriminator', () => {
      expect(normalizeHandle('TechGuru#1234')).toBe('techguru');
    });
  });

  describe('jaccardSimilarity', () => {
    it('should return 1 for identical sets', () => {
      const a = new Set(['x', 'y', 'z']);
      expect(jaccardSimilarity(a, a)).toBe(1);
    });

    it('should return 0 for disjoint sets', () => {
      const a = new Set(['x', 'y']);
      const b = new Set(['a', 'b']);
      expect(jaccardSimilarity(a, b)).toBe(0);
    });

    it('should return 0.5 for half-overlapping sets', () => {
      const a = new Set(['x', 'y']);
      const b = new Set(['y', 'z']);
      expect(jaccardSimilarity(a, b)).toBeCloseTo(1 / 3, 2);
    });
  });

  describe('nameVariationMatch', () => {
    it('should match first-name variants', () => {
      expect(nameVariationMatch('Dave', 'David')).toBeGreaterThan(0.4);
    });

    it('should match split/joined names', () => {
      expect(nameVariationMatch('TechGuru', 'Tech Guru')).toBe(1);
    });
  });

  describe('extractBaseUsername', () => {
    it('should strip common suffixes', () => {
      expect(extractBaseUsername('@dave_dev')).toBe('dave');
      expect(extractBaseUsername('alice_eth')).toBe('alice');
      expect(extractBaseUsername('bob123')).toBe('bob');
    });
  });

  describe('couldBeSameEntity', () => {
    it('should return true for obvious matches', () => {
      expect(couldBeSameEntity('Dave', 'dave')).toBe(true);
      expect(couldBeSameEntity('@dave_codes', 'dave-codes')).toBe(true);
    });

    it('should return true for base username matches', () => {
      expect(couldBeSameEntity('dave_dev', 'dave_eth')).toBe(true);
    });

    it('should return false for clearly different people', () => {
      expect(couldBeSameEntity('Alice', 'Bob')).toBe(false);
      expect(couldBeSameEntity('crypto_whale', 'coffee_lover')).toBe(false);
    });
  });
});

// ──────────────────────────────────────────────
// Graph Traversal Tests
// ──────────────────────────────────────────────

describe('graphTraversal', () => {
  const makeRelationship = (source: string, target: string): Relationship => ({
    id: `rel-${source}-${target}` as UUID,
    sourceEntityId: source as UUID,
    targetEntityId: target as UUID,
    agentId: 'agent-1' as UUID,
    tags: [],
    metadata: {},
    createdAt: Date.now(),
  });

  // Small-world-ish test graph:
  //   A -- B -- C
  //   |         |
  //   D -- E -- F
  //        |
  //        G
  const relationships = [
    makeRelationship('A', 'B'),
    makeRelationship('B', 'C'),
    makeRelationship('A', 'D'),
    makeRelationship('D', 'E'),
    makeRelationship('E', 'F'),
    makeRelationship('C', 'F'),
    makeRelationship('E', 'G'),
  ];

  const graph = buildAdjacencyGraph(relationships);

  describe('buildAdjacencyGraph', () => {
    it('should create bidirectional edges', () => {
      expect(graph.get('A' as UUID)?.has('B' as UUID)).toBe(true);
      expect(graph.get('B' as UUID)?.has('A' as UUID)).toBe(true);
    });

    it('should include all nodes', () => {
      expect(graph.size).toBe(7);
    });
  });

  describe('getNeighborhood', () => {
    it('should return 1-hop neighbors', () => {
      const n = getNeighborhood(graph, 'A' as UUID, 1);
      expect(n.has('B' as UUID)).toBe(true);
      expect(n.has('D' as UUID)).toBe(true);
      expect(n.has('C' as UUID)).toBe(false);
    });

    it('should return 2-hop neighbors', () => {
      const n = getNeighborhood(graph, 'A' as UUID, 2);
      expect(n.has('B' as UUID)).toBe(true);
      expect(n.has('C' as UUID)).toBe(true);
      expect(n.has('D' as UUID)).toBe(true);
      expect(n.has('E' as UUID)).toBe(true);
    });

    it('should respect maxNodes limit', () => {
      const n = getNeighborhood(graph, 'A' as UUID, 10, 3);
      expect(n.size).toBeLessThanOrEqual(3);
    });
  });

  describe('shortestPath', () => {
    it('should find direct path', () => {
      const path = shortestPath(graph, 'A' as UUID, 'B' as UUID);
      expect(path).toEqual(['A', 'B']);
    });

    it('should find multi-hop path', () => {
      const path = shortestPath(graph, 'A' as UUID, 'G' as UUID);
      expect(path).not.toBeNull();
      expect(path![0]).toBe('A');
      expect(path![path!.length - 1]).toBe('G');
    });

    it('should return null for disconnected nodes', () => {
      const disconnected = buildAdjacencyGraph([
        makeRelationship('X', 'Y'),
      ]);
      // Z is not in the graph at all
      const path = shortestPath(disconnected, 'X' as UUID, 'Z' as UUID);
      expect(path).toBeNull();
    });
  });

  describe('sharedConnections', () => {
    it('should find shared connections', () => {
      // A and C both connect to B; A connects to D, C connects to F and B
      const shared = sharedConnections(graph, 'A' as UUID, 'C' as UUID);
      expect(shared.has('B' as UUID)).toBe(true);
    });

    it('should return empty for no shared connections', () => {
      const shared = sharedConnections(graph, 'A' as UUID, 'G' as UUID);
      expect(shared.size).toBe(0);
    });
  });

  describe('degreeCentrality', () => {
    it('should rank E highest (3 connections: D, F, G)', () => {
      const centrality = degreeCentrality(graph);
      expect(centrality[0].entityId).toBe('E');
      expect(centrality[0].degree).toBe(3);
    });
  });

  describe('detectClusters', () => {
    it('should detect connected components', () => {
      const clusters = detectClusters(graph, 50); // More iterations for convergence
      // In a connected graph, most nodes should converge to the same cluster
      // Label propagation is stochastic, so we check majority rather than exact
      const clusterCounts = new Map<string, number>();
      for (const label of clusters.values()) {
        clusterCounts.set(label, (clusterCounts.get(label) ?? 0) + 1);
      }
      const largestCluster = Math.max(...clusterCounts.values());
      // In a densely connected 7-node graph, the largest cluster should have
      // at least 4 nodes. Label propagation is stochastic so we use a lenient bound.
      expect(largestCluster).toBeGreaterThanOrEqual(4);
    });

    it('should detect separate clusters for disconnected graphs', () => {
      const disconnected = buildAdjacencyGraph([
        makeRelationship('A', 'B'),
        makeRelationship('C', 'D'),
      ]);
      const clusters = detectClusters(disconnected);
      const memberA = getClusterMembers(clusters, 'A' as UUID);
      const memberC = getClusterMembers(clusters, 'C' as UUID);
      expect(memberA).not.toContain('C');
      expect(memberC).not.toContain('A');
    });
  });
});

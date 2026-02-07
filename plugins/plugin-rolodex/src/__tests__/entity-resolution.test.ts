/**
 * Unit tests for the EntityResolutionService.
 *
 * Tests the core resolution logic (candidate generation, scoring,
 * small-world neighborhood scanning) using mock data, without
 * requiring a full runtime.
 */

import { describe, it, expect } from 'vitest';

import {
  nameSimilarity,
  handleCorrelation,
  normalizeHandle,
  jaccardSimilarity,
  couldBeSameEntity,
} from '../utils/similarity';

import {
  buildAdjacencyGraph,
  getNeighborhood,
  sharedConnections,
} from '../utils/graphTraversal';

import { RESOLUTION_THRESHOLDS, SIGNAL_WEIGHTS } from '../types/index';
import type { ResolutionSignal, ResolutionSignalType } from '../types/index';
import type { UUID, Relationship } from '@elizaos/core';

// ──────────────────────────────────────────────
// Scoring Logic Tests (extracted from service)
// ──────────────────────────────────────────────

function scoreCandidate(signals: ResolutionSignal[]): number {
  if (signals.length === 0) return 0;

  const byType = new Map<ResolutionSignalType, ResolutionSignal[]>();
  for (const signal of signals) {
    const group = byType.get(signal.type) ?? [];
    group.push(signal);
    byType.set(signal.type, group);
  }

  let totalScore = 0;

  for (const [type, typeSignals] of byType) {
    const typeWeight = SIGNAL_WEIGHTS[type] ?? 0.1;
    const sorted = typeSignals.sort((a, b) => b.weight - a.weight);
    let typeScore = sorted[0].weight * typeWeight;

    for (let i = 1; i < sorted.length; i++) {
      typeScore += sorted[i].weight * typeWeight * Math.pow(0.3, i);
    }

    totalScore += typeScore;
  }

  return Math.max(0, Math.min(1, totalScore));
}

describe('Entity Resolution Scoring', () => {
  it('should score same-handle-different-platform highly', () => {
    const signals: ResolutionSignal[] = [
      {
        type: 'handle_correlation',
        weight: 0.95,
        evidence: 'Same handle on different platforms: davebuilds',
        timestamp: Date.now(),
      },
    ];
    const score = scoreCandidate(signals);
    // handle_correlation weight is 0.25, so 0.95 * 0.25 = 0.2375
    expect(score).toBeGreaterThan(0.2);
  });

  it('should score self-identification very highly', () => {
    const signals: ResolutionSignal[] = [
      {
        type: 'self_identification',
        weight: 0.9,
        evidence: 'User said "that\'s me" when asked about the other account',
        timestamp: Date.now(),
      },
    ];
    const score = scoreCandidate(signals);
    // self_identification weight is 0.30, so 0.9 * 0.30 = 0.27
    expect(score).toBeGreaterThan(0.25);
  });

  it('should score multiple weak signals above threshold when combined', () => {
    const signals: ResolutionSignal[] = [
      {
        type: 'name_match',
        weight: 0.7,
        evidence: '"Dave_D" ~ "dave_codes"',
        timestamp: Date.now(),
      },
      {
        type: 'project_affinity',
        weight: 0.8,
        evidence: 'Both mention ChainTracker project',
        timestamp: Date.now(),
      },
      {
        type: 'handle_correlation',
        weight: 0.75,
        evidence: 'davebuilds on GitHub from both accounts',
        timestamp: Date.now(),
      },
      {
        type: 'shared_connections',
        weight: 0.3,
        evidence: '2 shared connections',
        timestamp: Date.now(),
      },
    ];
    const score = scoreCandidate(signals);
    expect(score).toBeGreaterThan(RESOLUTION_THRESHOLDS.PROPOSE);
  });

  it('should not exceed threshold for a single weak signal', () => {
    const signals: ResolutionSignal[] = [
      {
        type: 'name_match',
        weight: 0.6,
        evidence: '"Alex" ~ "Alex J"',
        timestamp: Date.now(),
      },
    ];
    const score = scoreCandidate(signals);
    // name_match weight is 0.15, so 0.6 * 0.15 = 0.09
    expect(score).toBeLessThan(RESOLUTION_THRESHOLDS.PROPOSE);
  });

  it('should have diminishing returns for multiple signals of same type', () => {
    const oneSignal: ResolutionSignal[] = [
      {
        type: 'name_match',
        weight: 0.8,
        evidence: 'match 1',
        timestamp: Date.now(),
      },
    ];

    const twoSignals: ResolutionSignal[] = [
      ...oneSignal,
      {
        type: 'name_match',
        weight: 0.8,
        evidence: 'match 2',
        timestamp: Date.now(),
      },
    ];

    const score1 = scoreCandidate(oneSignal);
    const score2 = scoreCandidate(twoSignals);

    // Second signal should add less than the first
    expect(score2).toBeGreaterThan(score1);
    expect(score2).toBeLessThan(score1 * 2);
  });

  it('should auto-confirm admin confirmation', () => {
    const signals: ResolutionSignal[] = [
      {
        type: 'admin_confirmation',
        weight: 1.0,
        evidence: 'Admin confirmed identity match',
        timestamp: Date.now(),
      },
    ];
    const score = scoreCandidate(signals);
    expect(score).toBeGreaterThanOrEqual(RESOLUTION_THRESHOLDS.AUTO_CONFIRM);
  });
});

// ──────────────────────────────────────────────
// Small-World Resolution Strategy Tests
// ──────────────────────────────────────────────

describe('Small-World Resolution Strategy', () => {
  const makeRelationship = (source: string, target: string): Relationship => ({
    id: `rel-${source}-${target}` as UUID,
    sourceEntityId: source as UUID,
    targetEntityId: target as UUID,
    agentId: 'agent-1' as UUID,
    tags: [],
    metadata: {},
    createdAt: Date.now(),
  });

  it('should find candidates within 2-hop neighborhood', () => {
    // Dave_D (Discord) -- knows Alice -- knows dave_codes (Twitter)
    const relationships = [
      makeRelationship('dave_d', 'alice'),
      makeRelationship('alice', 'dave_codes'),
      makeRelationship('alice', 'bob'),
      makeRelationship('bob', 'charlie'),
    ];

    const graph = buildAdjacencyGraph(relationships);
    const neighborhood = getNeighborhood(graph, 'dave_d' as UUID, 2);

    // dave_codes should be in the 2-hop neighborhood
    expect(neighborhood.has('dave_codes' as UUID)).toBe(true);
    // charlie is 3 hops away — should NOT be included
    expect(neighborhood.has('charlie' as UUID)).toBe(false);
  });

  it('should identify shared connections as a signal', () => {
    const relationships = [
      makeRelationship('entity_a', 'alice'),
      makeRelationship('entity_a', 'bob'),
      makeRelationship('entity_a', 'charlie'),
      makeRelationship('entity_b', 'alice'),
      makeRelationship('entity_b', 'bob'),
      makeRelationship('entity_b', 'diana'),
    ];

    const graph = buildAdjacencyGraph(relationships);
    const shared = sharedConnections(graph, 'entity_a' as UUID, 'entity_b' as UUID);

    // Both know Alice and Bob
    expect(shared.size).toBe(2);
    expect(shared.has('alice' as UUID)).toBe(true);
    expect(shared.has('bob' as UUID)).toBe(true);
  });

  it('should limit neighborhood scan to maxNodes', () => {
    // Create a large fan-out graph
    const relationships: Relationship[] = [];
    for (let i = 0; i < 300; i++) {
      relationships.push(makeRelationship('hub', `node_${i}`));
    }

    const graph = buildAdjacencyGraph(relationships);
    const neighborhood = getNeighborhood(graph, 'hub' as UUID, 1, 50);

    expect(neighborhood.size).toBeLessThanOrEqual(50);
  });
});

// ──────────────────────────────────────────────
// The Dave Scenario (Integration-level unit test)
// ──────────────────────────────────────────────

describe('The Dave Scenario — Cross-Platform Identity', () => {
  it('should generate strong signals for Dave across platforms', () => {
    // Simulate what the EntityResolutionService would compute
    // Dave_D on Discord has:
    //   - name: "Dave_D"
    //   - github: "davebuilds"
    //   - mentioned project: "ChainTracker"
    //   - mentioned event: "ETH Denver"
    //
    // dave_codes on Twitter has:
    //   - name: "dave_codes"
    //   - github: "davebuilds"
    //   - mentioned project: "ChainTracker"
    //   - mentioned event: "ETH Denver"

    // Signal 1: Name similarity
    const nameSim = nameSimilarity('Dave_D', 'dave_codes');
    // These names aren't super similar, but both contain "dave"
    expect(nameSim).toBeGreaterThan(0.3);

    // Signal 2: Handle correlation (github handles are identical!)
    const githubCorrelation = handleCorrelation('davebuilds', 'davebuilds');
    expect(githubCorrelation).toBe(1.0);

    // Signal 3: Could they be the same entity?
    // The GitHub handle match should be the strongest signal
    expect(couldBeSameEntity('davebuilds', 'davebuilds')).toBe(true);

    // Simulate scoring with combined signals
    const signals: ResolutionSignal[] = [
      {
        type: 'handle_correlation',
        weight: 1.0, // Exact GitHub match
        evidence: 'Same GitHub: davebuilds',
        timestamp: Date.now(),
      },
      {
        type: 'project_affinity',
        weight: 0.9, // Both mention ChainTracker
        evidence: 'Both working on ChainTracker',
        timestamp: Date.now(),
      },
      {
        type: 'name_match',
        weight: nameSim,
        evidence: '"Dave_D" ~ "dave_codes"',
        timestamp: Date.now(),
      },
    ];

    const score = scoreCandidate(signals);

    // With exact GitHub match + project affinity + name similarity,
    // this should easily pass the proposal threshold
    expect(score).toBeGreaterThan(RESOLUTION_THRESHOLDS.PROPOSE);
  });

  it('should NOT match two different Alexes despite name similarity', () => {
    // Alex (designer, SF, @alex_designs) vs Alex J (backend, London, @alexj_distributed)
    const nameSim = nameSimilarity('Alex', 'Alex J');
    expect(nameSim).toBeGreaterThan(0.5); // Names ARE similar

    const handleSim = handleCorrelation('@alex_designs', '@alexj_distributed');
    expect(handleSim).toBeLessThan(0.5); // Handles are different

    // Scoring with only name match and mismatched handles
    const signals: ResolutionSignal[] = [
      {
        type: 'name_match',
        weight: nameSim,
        evidence: '"Alex" ~ "Alex J"',
        timestamp: Date.now(),
      },
    ];

    const score = scoreCandidate(signals);

    // A single name match should NOT be enough to propose a merge
    expect(score).toBeLessThan(RESOLUTION_THRESHOLDS.PROPOSE);
  });
});

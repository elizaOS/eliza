import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { TrustEngine } from '../TrustEngine';
import type { IAgentRuntime, UUID } from '@elizaos/core';
import { TrustEvidenceType, type TrustContext, type TrustEvidence, type TrustInteraction } from '../../types/trust';

// Mock IAgentRuntime
const createMockRuntime = (): IAgentRuntime =>
  ({
    agentId: 'test-agent' as UUID,
    log: vi.fn(),
    getComponents: vi.fn().mockResolvedValue([]),
    getComponent: vi.fn().mockResolvedValue(null),
    createComponent: vi.fn().mockResolvedValue(undefined),
    updateComponent: vi.fn().mockResolvedValue(undefined),
    ensureWorldExists: vi.fn().mockResolvedValue(undefined),
    // Add other necessary methods and properties
  } as any);

const createEvidence = (
  type: TrustEvidenceType,
  impact: number,
  verified = false
): TrustEvidence => ({
  type,
  timestamp: Date.now(),
  impact,
  weight: 1.0,
  description: '',
  reportedBy: 'reporter' as UUID,
  targetEntityId: 'target' as UUID,
  verified,
  context: { evaluatorId: 'evaluator' as UUID },
  evaluatorId: 'evaluator' as UUID,
});

describe('TrustEngine', () => {
  let trustEngine: TrustEngine;
  let runtime: IAgentRuntime;

  beforeEach(async () => {
    runtime = createMockRuntime();
    trustEngine = new TrustEngine();
    await trustEngine.initialize(runtime);
  });

  it('should initialize with default trust values', async () => {
    const subjectId = 'test-subject' as UUID;
    const context: TrustContext = { evaluatorId: 'test-evaluator' as UUID };

    const profile = await trustEngine.calculateTrust(subjectId, context);

    expect(profile.overallTrust).toBe(50);
    expect(profile.dimensions.reliability).toBe(50);
    expect(profile.dimensions.competence).toBe(50);
    expect(profile.dimensions.integrity).toBe(50);
    expect(profile.dimensions.benevolence).toBe(50);
    expect(profile.dimensions.transparency).toBe(50);
    expect(profile.confidence).toBe(0);
    expect(profile.interactionCount).toBe(0);
  });

  it('should increase trust with positive evidence', async () => {
    const subjectId = 'test-subject' as UUID;
    const context: TrustContext = { evaluatorId: 'test-evaluator' as UUID };

    const positiveEvidence: TrustEvidence[] = [
      {
        type: TrustEvidenceType.PROMISE_KEPT,
        timestamp: Date.now(),
        impact: 10,
        weight: 1.0,
        description: 'Delivered on time',
        reportedBy: 'reporter' as UUID,
        verified: false,
        context,
        targetEntityId: subjectId,
        evaluatorId: context.evaluatorId,
      },
       {
        type: TrustEvidenceType.HELPFUL_ACTION,
        timestamp: Date.now(),
        impact: 8,
        weight: 1.0,
        description: 'Provided support',
        reportedBy: 'reporter' as UUID,
        verified: false,
        context,
        targetEntityId: subjectId,
        evaluatorId: context.evaluatorId,
      },
    ];

    (runtime.getComponents as Mock).mockResolvedValue(
      positiveEvidence.map((e) => ({ type: 'trust_evidence', data: e }))
    );
    
    // We need at least 3 pieces of evidence for confidence to be > 0
    await trustEngine.recordInteraction({ type: TrustEvidenceType.PROMISE_KEPT, sourceEntityId: subjectId, targetEntityId: subjectId, timestamp: Date.now(), impact: 10, context });


    const profile = await trustEngine.calculateTrust(subjectId, context);

    expect(profile.overallTrust).toBeGreaterThan(50);
    expect(profile.dimensions.reliability).toBeGreaterThan(50);
    expect(profile.dimensions.benevolence).toBeGreaterThan(50);
  });
  
    it('should decrease trust with negative evidence', async () => {
    const subjectId = 'test-subject' as UUID;
    const context: TrustContext = { evaluatorId: 'test-evaluator' as UUID };

    const negativeEvidence: TrustEvidence[] = [
      {
        type: TrustEvidenceType.PROMISE_BROKEN,
        timestamp: Date.now(),
        impact: -15,
        weight: 1.0,
        description: 'Missed deadline',
        reportedBy: 'reporter' as UUID,
        verified: false,
        context,
        targetEntityId: subjectId,
        evaluatorId: context.evaluatorId,
      },
    ];

     (runtime.getComponents as Mock).mockResolvedValue(
      negativeEvidence.map((e) => ({ type: 'trust_evidence', data: e }))
    );
    
    await trustEngine.recordInteraction({ type: TrustEvidenceType.PROMISE_BROKEN, sourceEntityId: subjectId, targetEntityId: subjectId, timestamp: Date.now(), impact: -15, context });

    const profile = await trustEngine.calculateTrust(subjectId, context);

    expect(profile.overallTrust).toBeLessThan(50);
    expect(profile.dimensions.reliability).toBeLessThan(50);
  });

  it('should handle evidence decay over time', async () => {
    const subjectId = 'test-subject' as UUID;
    const context: TrustContext = { evaluatorId: 'test-evaluator' as UUID };
    
    const oldEvidence: TrustEvidence = {
        type: TrustEvidenceType.PROMISE_KEPT,
        timestamp: Date.now() - (365 * 24 * 60 * 60 * 1000), // 1 year old
        impact: 20,
        weight: 1.0,
        description: 'Very old promise kept',
        reportedBy: 'reporter' as UUID,
        verified: false,
        context,
        targetEntityId: subjectId,
        evaluatorId: context.evaluatorId
    };

    (runtime.getComponents as Mock).mockResolvedValue([{ type: 'trust_evidence', data: oldEvidence }]);

    const profile = await trustEngine.calculateTrust(subjectId, context);
    
    // The impact should be significantly decayed, so the trust score should be close to 50
    expect(profile.overallTrust).toBeLessThan(60);
    expect(profile.overallTrust).toBeGreaterThan(40);
  });

  it('should increase confidence with more evidence', async () => {
    const entityId = 'test-entity-confidence' as UUID;
    const context = { evaluatorId: runtime.agentId };
    
    // Mock the getComponents to return our evidence
    const mockEvidence: TrustEvidence[] = [];
    
    // Record multiple interactions to build evidence
    for (let i = 0; i < 5; i++) {
      const evidence: TrustEvidence = {
        type: TrustEvidenceType.CONSISTENT_BEHAVIOR,
        timestamp: Date.now() - i * 1000,
        impact: 5,
        weight: 1.0,
        description: `Consistent behavior ${i}`,
        reportedBy: runtime.agentId,
        targetEntityId: entityId,
        verified: true,
        context,
        evaluatorId: context.evaluatorId,
      };
      mockEvidence.push(evidence);
      
      await trustEngine.recordInteraction({
        sourceEntityId: entityId,
        targetEntityId: runtime.agentId,
        type: TrustEvidenceType.CONSISTENT_BEHAVIOR,
        timestamp: Date.now() - i * 1000,
        impact: 5,
        context,
      });
    }
    
    // Mock getComponents to return our evidence
    (runtime.getComponents as Mock).mockResolvedValue(
      mockEvidence.map(e => ({
        type: 'trust_evidence',
        data: e,
        agentId: runtime.agentId,
        entityId,
      }))
    );

    const profile = await trustEngine.calculateTrust(entityId, context);
    
    // With 5 pieces of evidence (more than minimum of 3), confidence should be > 0
    expect(profile.confidence).toBeGreaterThan(0);
    expect(profile.confidence).toBeLessThanOrEqual(1);
    expect(profile.interactionCount).toBeGreaterThanOrEqual(5);
  });

  it('should handle trust requirements evaluation', async () => {
    const entityId = 'test-entity' as UUID;
    const context = { evaluatorId: 'test-evaluator' as UUID };
    
    // Record some positive interactions first
    await trustEngine.recordInteraction({
      sourceEntityId: entityId,
      targetEntityId: runtime.agentId,
      type: TrustEvidenceType.HELPFUL_ACTION,
      timestamp: Date.now(),
      impact: 20,
      context,
    });
    
    // Test with high trust requirements
    const highRequirements = {
      minimumTrust: 80,
      minimumConfidence: 70,
      dimensions: {
        reliability: 75,
        integrity: 80,
      },
    };

    const decision = await trustEngine.evaluateTrustDecision(entityId, highRequirements, context);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('below required');
  });

  it('should get recent interactions', async () => {
    const entityId = 'test-entity' as UUID;
    
    // Record some interactions
    await trustEngine.recordInteraction({
      sourceEntityId: entityId,
      targetEntityId: 'target' as UUID,
      type: TrustEvidenceType.HELPFUL_ACTION,
      timestamp: Date.now(),
      impact: 10,
      context: { evaluatorId: runtime.agentId },
    });

    const interactions = await trustEngine.getRecentInteractions(entityId, 5);
    expect(interactions).toHaveLength(1);
    expect(interactions[0].type).toBe(TrustEvidenceType.HELPFUL_ACTION);
  });

  it('should handle different trust evidence types', async () => {
    const evidenceTypes = [
      { type: TrustEvidenceType.VERIFIED_IDENTITY, expectedImpact: 'positive' },
      { type: TrustEvidenceType.CONSISTENT_BEHAVIOR, expectedImpact: 'positive' },
      { type: TrustEvidenceType.PROMISE_BROKEN, expectedImpact: 'negative' },
      { type: TrustEvidenceType.HARMFUL_ACTION, expectedImpact: 'negative' },
      { type: TrustEvidenceType.SECURITY_VIOLATION, expectedImpact: 'negative' },
    ];

    for (const { type, expectedImpact } of evidenceTypes) {
      const entityId = `test-entity-${type}` as UUID;
      const impact = expectedImpact === 'positive' ? 10 : -10;
      
      await trustEngine.recordInteraction({
        sourceEntityId: entityId,
        targetEntityId: runtime.agentId,
        type,
        timestamp: Date.now(),
        impact,
        context: { evaluatorId: runtime.agentId },
      });

      const profile = await trustEngine.calculateTrust(entityId, { evaluatorId: runtime.agentId });

      if (expectedImpact === 'positive') {
        expect(profile.overallTrust).toBeGreaterThanOrEqual(50);
      } else {
        expect(profile.overallTrust).toBeLessThanOrEqual(50);
      }
    }
  });

  it('should calculate dimension impacts correctly', async () => {
    const entityId = 'test-dimension-entity' as UUID;
    
    await trustEngine.recordInteraction({
      sourceEntityId: entityId,
      targetEntityId: runtime.agentId,
      type: TrustEvidenceType.PROMISE_KEPT,
      timestamp: Date.now(),
      impact: 20,
      context: { evaluatorId: runtime.agentId },
    });

    const profile = await trustEngine.calculateTrust(entityId, { evaluatorId: runtime.agentId });

    // Promise kept should impact reliability and integrity positively
    expect(profile.dimensions.reliability).toBeGreaterThanOrEqual(50);
    expect(profile.dimensions.integrity).toBeGreaterThanOrEqual(50);
  });

  it('should handle empty evidence', async () => {
    const entityId = 'empty-evidence-entity' as UUID;
    const profile = await trustEngine.calculateTrust(entityId, { evaluatorId: runtime.agentId });
    
    expect(profile.overallTrust).toBe(50);
    expect(profile.confidence).toBe(0);
  });
}); 
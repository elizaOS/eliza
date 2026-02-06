import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { evaluateTrustAction } from '../evaluateTrust';
import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import type { TrustProfile } from '../../types/trust';

const createMockRuntime = (): IAgentRuntime =>
  ({
    agentId: 'test-agent' as UUID,
    getService: vi.fn(),
  } as any);

const createMockMemory = (text: string, entityId: UUID): Memory =>
  ({
    entityId,
    content: {
      text,
    },
    roomId: 'room-1' as UUID,
  } as Memory);

const mockTrustProfile: TrustProfile = {
  entityId: 'entity-1' as UUID,
  evaluatorId: 'test-agent' as UUID,
  overallTrust: 75,
  confidence: 0.8,
  dimensions: {
    reliability: 80,
    competence: 75,
    integrity: 70,
    benevolence: 78,
    transparency: 72,
  },
  evidence: [],
  lastCalculated: Date.now(),
  calculationMethod: 'weighted_average',
  trend: {
    direction: 'stable',
    changeRate: 0,
    lastChangeAt: Date.now(),
  },
  interactionCount: 25,
};

describe('evaluateTrustAction', () => {
  let runtime: IAgentRuntime;
  let trustEngine: any;
  const testEntityId = 'entity-1' as UUID;

  beforeEach(() => {
    runtime = createMockRuntime();
    trustEngine = {
      evaluateTrust: vi.fn().mockResolvedValue(mockTrustProfile),
      calculateTrust: vi.fn().mockResolvedValue(mockTrustProfile),
    };
    (runtime.getService as Mock).mockReturnValue(trustEngine);
  });

  it('should return a simple trust level for the message sender', async () => {
    const memory = createMockMemory('What is my trust score?', testEntityId);
    const result = await evaluateTrustAction.handler(runtime, memory);

    expect(trustEngine.evaluateTrust).toHaveBeenCalledWith(
      testEntityId,
      runtime.agentId,
      expect.objectContaining({
        evaluatorId: runtime.agentId,
        roomId: 'room-1',
      })
    );

    expect(result).toBeDefined();
    expect((result as any).text).toContain('Trust Level: Good (75/100)');
    expect((result as any).text).toContain('25 interactions');
  });

  it('should return a detailed trust profile when requested', async () => {
    const memory = createMockMemory(
      '{"detailed": true}',
      testEntityId
    );
    const result = await evaluateTrustAction.handler(runtime, memory);

    expect(result).toBeDefined();
    expect((result as any).text).toContain('Trust Profile');
    expect((result as any).text).toContain('Overall Trust: 75/100');
    expect((result as any).text).toContain('Confidence: 80%');
    expect((result as any).text).toContain('reliability: 80/100');
  });

  it('should evaluate a specific entity if entityId is provided', async () => {
    const memory = createMockMemory(
      '{"entityId": "specific-entity", "detailed": false}',
      testEntityId
    );
    const result = await evaluateTrustAction.handler(runtime, memory);

    expect(trustEngine.evaluateTrust).toHaveBeenCalledWith(
      'specific-entity',
      runtime.agentId,
      expect.any(Object)
    );
    expect(result).toBeDefined();
  });

  it('should return an error if the trust engine service is not available', async () => {
    (runtime.getService as Mock).mockReturnValue(null);

    const memory = createMockMemory('What is my trust score?', testEntityId);
    
    await expect(evaluateTrustAction.handler(runtime, memory)).rejects.toThrow(
      'Trust engine service not available'
    );
  });

  it('should handle trust evaluation with specific context', async () => {
    const memory = createMockMemory('What is my trust score?', testEntityId);
    const result = await evaluateTrustAction.handler(runtime, memory);
    
    expect(trustEngine.evaluateTrust).toHaveBeenCalledWith(
      'entity-1',
      runtime.agentId,
      expect.objectContaining({
        evaluatorId: runtime.agentId,
        roomId: 'room-1',
      })
    );
    expect(result).toBeDefined();
  });

  it('should format trust profile with all dimensions', async () => {
    const memory = createMockMemory(
      '{"detailed": true}',
      testEntityId
    );

    const result = await evaluateTrustAction.handler(runtime, memory);

    expect(result).toBeDefined();
    expect((result as any).text).toContain('Trust Profile');
    expect((result as any).text).toContain('reliability');
    expect((result as any).text).toContain('competence');
    expect((result as any).text).toContain('integrity');
    expect((result as any).text).toContain('benevolence');
    expect((result as any).text).toContain('transparency');
  });

  it('should include trust level descriptions', async () => {
    // Test different trust levels
    const levels = [
      { score: 85, expected: 'High' },
      { score: 65, expected: 'Good' },
      { score: 45, expected: 'Moderate' },
      { score: 25, expected: 'Low' },
      { score: 10, expected: 'Very Low' },
    ];

    for (const { score, expected } of levels) {
      trustEngine.evaluateTrust.mockResolvedValue({
        ...mockTrustProfile,
        overallTrust: score,
      });

      const memory = createMockMemory('What is my trust score?', testEntityId);
      const result = await evaluateTrustAction.handler(runtime, memory);

      expect((result as any).text).toContain(`Trust Level: ${expected}`);
    }
  });

  it('should validate the action correctly', async () => {
    const memory = createMockMemory('What is my trust score?', testEntityId);
    expect(await evaluateTrustAction.validate(runtime, memory)).toBe(true);
    
    (runtime.getService as Mock).mockReturnValue(null);
    expect(await evaluateTrustAction.validate(runtime, memory)).toBe(false);
  });

  it('should handle errors gracefully', async () => {
    trustEngine.evaluateTrust.mockRejectedValue(new Error('Database error'));

    const memory = createMockMemory('What is my trust score?', testEntityId);
    const result = await evaluateTrustAction.handler(runtime, memory);

    expect((result as any).text).toContain('Failed to evaluate trust');
    expect((result as any).error).toBe(true);
  });

  it('should handle entity name resolution request', async () => {
    const memory = createMockMemory(
      '{"entityName": "Alice"}',
      testEntityId
    );
    const result = await evaluateTrustAction.handler(runtime, memory);

    expect((result as any).text).toContain('Entity name resolution not yet implemented');
    expect((result as any).error).toBe(true);
  });
}); 
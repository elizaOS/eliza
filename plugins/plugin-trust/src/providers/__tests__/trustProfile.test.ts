import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { trustProfileProvider } from '../trustProfile';
import type { IAgentRuntime, Memory, State, UUID } from '@elizaos/core';
import type { TrustProfile } from '../../types/trust';
import { type TrustEngineService } from '../../index';

// Mocks
const createMockRuntime = (): IAgentRuntime => {
  const trustEngineMock = {
    evaluateTrust: vi.fn(),
    getRecentInteractions: vi.fn().mockResolvedValue([]),
  };
  return {
    agentId: 'test-agent' as UUID,
    getService: vi.fn().mockReturnValue(trustEngineMock),
  } as any;
};

const createMockMemory = (entityId: UUID): Memory =>
  ({
    entityId,
    roomId: 'room-1' as UUID,
  } as Memory);
  
const mockState: State = {} as State;

const createMockProfile = (overallTrust: number, direction: 'increasing' | 'decreasing' | 'stable'): TrustProfile => ({
    entityId: 'user-1' as UUID,
    evaluatorId: 'test-agent' as UUID,
    overallTrust,
    confidence: 0.85,
    interactionCount: 127,
    lastCalculated: Date.now(),
    calculationMethod: 'test',
    trend: { direction, changeRate: 0.5, lastChangeAt: Date.now() },
    dimensions: {
      reliability: 82,
      competence: 75,
      integrity: 80,
      benevolence: 85,
      transparency: 70,
    },
    evidence: [],
});

describe('trustProfileProvider', () => {
  let runtime: IAgentRuntime;
  let trustEngine: any;
  const testEntityId = 'user-1' as UUID;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
    trustEngine = runtime.getService('trust-engine');
  });

  it('should return correct text and values for a high-trust user', async () => {
    const profile = createMockProfile(85, 'increasing');
    (trustEngine.evaluateTrust as Mock).mockResolvedValue(profile);
    const memory = createMockMemory(testEntityId);

    const result = await trustProfileProvider.get(runtime, memory, mockState);

    expect(result.text).toContain('The user has high trust (85/100) with improving trust trend');
    expect(result.values!.trustLevel).toBe('high trust');
    expect(result.values!.trustScore).toBe(85);
    expect(result.values!.trustTrend).toBe('increasing');
  });

  it('should return correct text for a low-trust, declining trend user', async () => {
    const profile = createMockProfile(30, 'decreasing');
    (trustEngine.evaluateTrust as Mock).mockResolvedValue(profile);
    const memory = createMockMemory(testEntityId);

    const result = await trustProfileProvider.get(runtime, memory, mockState);
    
    expect(result.text).toContain('The user has low trust (30/100) with declining trust trend');
    expect(result.values!.trustLevel).toBe('low trust');
    expect(result.values!.trustTrend).toBe('decreasing');
  });
  
  it('should return correct text for a stable trend user', async () => {
    const profile = createMockProfile(65, 'stable');
    (trustEngine.evaluateTrust as Mock).mockResolvedValue(profile);
    const memory = createMockMemory(testEntityId);

    const result = await trustProfileProvider.get(runtime, memory, mockState);
    
    expect(result.text).toContain('The user has good trust (65/100) with stable trust trend');
    expect(result.values!.trustLevel).toBe('good trust');
    expect(result.values!.trustTrend).toBe('stable');
  });
  
  it('should return an empty result if trust engine is not available', async () => {
    (runtime.getService as Mock).mockReturnValue(null);
    const memory = createMockMemory(testEntityId);
    
    const result = await trustProfileProvider.get(runtime, memory, mockState);

    expect(result.text).toBe('Trust engine not available');
    expect(result.values).toEqual({});
  });

  it('should return recent action counts in values', async () => {
    const profile = createMockProfile(70, 'stable');
    (trustEngine.evaluateTrust as Mock).mockResolvedValue(profile);
    (trustEngine.getRecentInteractions as Mock).mockResolvedValue([
        { impact: 10 }, { impact: 5 }, { impact: -10 }
    ]);
    const memory = createMockMemory(testEntityId);
    
    const result = await trustProfileProvider.get(runtime, memory, mockState);
    
    expect(result.values!.recentPositiveActions).toBe(2);
    expect(result.values!.recentNegativeActions).toBe(1);
  });
}); 
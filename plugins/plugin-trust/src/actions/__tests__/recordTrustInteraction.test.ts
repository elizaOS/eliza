import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { recordTrustInteractionAction } from '../recordTrustInteraction';
import type { IAgentRuntime, Memory, UUID } from '@elizaos/core';
import { TrustEvidenceType } from '../../types/trust';
import { type TrustEngineService } from '../../index';

// Mocks
const createMockRuntime = (): IAgentRuntime => {
  const trustEngineMock = {
    recordInteraction: vi.fn(),
  };

  return {
    agentId: 'test-agent' as UUID,
    getService: vi.fn().mockImplementation((serviceName: string) => {
      if (serviceName === 'trust-engine') {
        return trustEngineMock;
      }
      return null;
    }),
  } as any;
};

const createMockMemory = (text: string, entityId: UUID): Memory =>
  ({
    id: 'mem-1' as UUID,
    entityId,
    roomId: 'room-1' as UUID,
    content: {
      text,
    },
  } as Memory);

describe('recordTrustInteractionAction', () => {
  let runtime: IAgentRuntime;
  let trustEngine: any;
  const testEntityId = 'user-1' as UUID;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
    trustEngine = runtime.getService('trust-engine');
  });

  it('should successfully record a trust interaction', async () => {
    const interactionData = {
      type: 'PROMISE_KEPT',
      impact: 15,
      description: 'User delivered the report as promised.',
    };
    const message = createMockMemory(JSON.stringify(interactionData), testEntityId);
    (trustEngine.recordInteraction as Mock).mockResolvedValue({ success: true });

    const result: any = await recordTrustInteractionAction.handler(runtime, message);

    expect(trustEngine.recordInteraction).toHaveBeenCalledOnce();
    const recordedInteraction = (trustEngine.recordInteraction as Mock).mock.calls[0][0];
    expect(recordedInteraction.type).toBe(TrustEvidenceType.PROMISE_KEPT);
    expect(recordedInteraction.impact).toBe(15);
    expect(recordedInteraction.sourceEntityId).toBe(testEntityId);
    expect(result.text).toContain('Trust interaction recorded: PROMISE_KEPT with impact +15');
  });

  it('should return an error if interaction type is missing', async () => {
    const interactionData = { impact: 10, description: 'something good' };
    const message = createMockMemory(JSON.stringify(interactionData), testEntityId);

    const result: any = await recordTrustInteractionAction.handler(runtime, message);

    expect(trustEngine.recordInteraction).not.toHaveBeenCalled();
    expect(result.error).toBe(true);
    expect(result.text).toContain('Could not parse trust interaction details');
  });

  it('should return an error for an invalid interaction type', async () => {
    const interactionData = { type: 'MADE_A_JOKE', impact: 2 };
    const message = createMockMemory(JSON.stringify(interactionData), testEntityId);

    const result: any = await recordTrustInteractionAction.handler(runtime, message);

    expect(trustEngine.recordInteraction).not.toHaveBeenCalled();
    expect(result.error).toBe(true);
    expect(result.text).toContain('Invalid interaction type');
  });
  
  it('should throw an error if the trust engine service is not available', async () => {
    (runtime.getService as Mock).mockReturnValue(null);
    const message = createMockMemory('{}', testEntityId);
    
    await expect(recordTrustInteractionAction.handler(runtime, message)).rejects.toThrow('Trust engine service not available');
  });

  it('should use default values for targetEntityId and impact', async () => {
    const interactionData = { type: 'SPAM_BEHAVIOR' }; // No impact or target specified
    const message = createMockMemory(JSON.stringify(interactionData), testEntityId);
    (trustEngine.recordInteraction as Mock).mockResolvedValue({ success: true });
    
    await recordTrustInteractionAction.handler(runtime, message);

    expect(trustEngine.recordInteraction).toHaveBeenCalledOnce();
    const recordedInteraction = (trustEngine.recordInteraction as Mock).mock.calls[0][0];
    
    expect(recordedInteraction.targetEntityId).toBe(runtime.agentId);
    expect(recordedInteraction.impact).toBe(10); // default impact
  });
}); 
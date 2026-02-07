import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { trustChangeEvaluator } from '../trustChangeEvaluator';
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

describe('trustChangeEvaluator', () => {
  let runtime: IAgentRuntime;
  let trustEngine: any;
  const testEntityId = 'user-1' as UUID;

  beforeEach(() => {
    vi.clearAllMocks();
    runtime = createMockRuntime();
    trustEngine = runtime.getService('trust-engine');
  });

  describe('validate', () => {
    it('should return true if trust-engine service is available', async () => {
      const isValid = await trustChangeEvaluator.validate!(runtime, {} as Memory);
      expect(isValid).toBe(true);
    });

    it('should return false if trust-engine service is not available', async () => {
      (runtime.getService as Mock).mockReturnValue(null);
      const isValid = await trustChangeEvaluator.validate!(runtime, {} as Memory);
      expect(isValid).toBe(false);
    });
  });

  describe('handler', () => {
    it('should record a positive interaction for a thankful message', async () => {
      const message = createMockMemory('thank you so much for your help!', testEntityId);
      await trustChangeEvaluator.handler(runtime, message);

      expect(trustEngine.recordInteraction).toHaveBeenCalledOnce();
      const interaction = (trustEngine.recordInteraction as Mock).mock.calls[0][0];
      expect(interaction.type).toBe(TrustEvidenceType.HELPFUL_ACTION);
      expect(interaction.impact).toBe(5);
    });

    it('should record a negative interaction for a spam message', async () => {
      const message = createMockMemory('spam spam spam buy now', testEntityId);
      await trustChangeEvaluator.handler(runtime, message);

      expect(trustEngine.recordInteraction).toHaveBeenCalledOnce();
      const interaction = (trustEngine.recordInteraction as Mock).mock.calls[0][0];
      expect(interaction.type).toBe(TrustEvidenceType.SPAM_BEHAVIOR);
      expect(interaction.impact).toBe(-10);
    });

    it('should record a strong negative interaction for a security violation message', async () => {
        const message = createMockMemory('I will hack your system', testEntityId);
        await trustChangeEvaluator.handler(runtime, message);
  
        expect(trustEngine.recordInteraction).toHaveBeenCalledOnce();
        const interaction = (trustEngine.recordInteraction as Mock).mock.calls[0][0];
        expect(interaction.type).toBe(TrustEvidenceType.SECURITY_VIOLATION);
        expect(interaction.impact).toBe(-25);
    });

    it('should not record any interaction for a neutral message', async () => {
      const message = createMockMemory('The weather is nice today.', testEntityId);
      await trustChangeEvaluator.handler(runtime, message);

      expect(trustEngine.recordInteraction).not.toHaveBeenCalled();
    });
    
    it('should return null if trust-engine is not available', async () => {
        (runtime.getService as Mock).mockReturnValue(null);
        const message = createMockMemory('a message', testEntityId);
        const result = await trustChangeEvaluator.handler(runtime, message);

        expect(result).toBeNull();
    });
  });
}); 
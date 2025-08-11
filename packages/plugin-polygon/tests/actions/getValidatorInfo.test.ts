import { describe, it, beforeEach, vi, expect } from 'vitest';
import { getValidatorInfoAction } from '../../src/actions/getValidatorInfo';
import { PolygonRpcService } from '../../src/services/PolygonRpcService';
import type { IAgentRuntime, Memory, State, Content } from '@elizaos/core';
import { logger, parseJSONObjectFromText } from '@elizaos/core';
import { 
  mockRuntime, 
  mockPolygonRpcService,
  mockCreateGetValidatorInfo
} from '../../vitest.setup';
import {
  createMockMessage,
  createMockState,
  createMockCallback,
  setupPolygonServiceMethod,
  resetCommonMocks
} from '../test-helpers';

// Mock the logger and other core utilities
vi.mock('@elizaos/core', async () => {
  const actualCore = await vi.importActual<typeof import('@elizaos/core')>('@elizaos/core');
  return {
    ...actualCore,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    parseJSONObjectFromText: vi.fn((text) => {
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`Failed to parse JSON during test: ${text}`);
      }
    }),
  };
});

describe('getValidatorInfoAction', () => {
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: ReturnType<typeof createMockCallback>;
  
  // Test constants
  const VALID_VALIDATOR_ID = 123;
  const MOCK_VALIDATOR_INFO = {
    status: 1, // Active
    totalStake: BigInt('10000000000000000000'), // 10 MATIC
    commissionRate: 10, // 10%
    signerAddress: '0xSignerAddress',
    activationEpoch: 100n,
    deactivationEpoch: 0n,
    jailTime: 0n,
    contractAddress: '0xValidatorShareAddress',
    lastRewardUpdateEpoch: 90n
  };

  beforeEach(() => {
    resetCommonMocks();
    
    // Create standard test objects
    mockMessage = createMockMessage('Get information about validator 123');
    mockState = createMockState([mockMessage]);
    mockCallback = createMockCallback();
    
    // Setup standard return values for getValidatorInfo
    const mockGetValidatorInfo = mockCreateGetValidatorInfo(MOCK_VALIDATOR_INFO);
    setupPolygonServiceMethod('getValidatorInfo', mockGetValidatorInfo);
    
    // Setup useModel mock for parameter extraction
    vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
      JSON.stringify({
        validatorId: VALID_VALIDATOR_ID
      })
    );
  });

  describe('validate', () => {
    it('should return true if all required settings and services are available', async () => {
      // Setup getSetting to return required values
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'POLYGON_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });

      const isValid = await getValidatorInfoAction.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(true);
    });

    it('should return false if POLYGON_RPC_URL is missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'POLYGON_RPC_URL') return null;
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });

      const isValid = await getValidatorInfoAction.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Required setting POLYGON_RPC_URL not configured')
      );
    });
    
    it('should return false if POLYGON_PLUGINS_ENABLED is false or missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'POLYGON_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return false;
        return null;
      });

      const isValid = await getValidatorInfoAction.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Required setting POLYGON_PLUGINS_ENABLED not configured')
      );
    });
    
    it('should return false if PolygonRpcService is not available', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'POLYGON_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });
      
      vi.spyOn(mockRuntime, 'getService').mockReturnValue(null);

      const isValid = await getValidatorInfoAction.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('PolygonRpcService not initialized')
      );
    });
  });

  describe('handler', () => {
    it('should successfully retrieve validator info with valid parameters from LLM', async () => {
      await getValidatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      // Verify service was called with correct parameters
      expect(mockPolygonRpcService.getValidatorInfo).toHaveBeenCalledWith(VALID_VALIDATOR_ID);

      // Verify callback was called with success message
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Validator Information'),
          actions: ['GET_VALIDATOR_INFO'],
          data: expect.objectContaining({
            validatorId: VALID_VALIDATOR_ID,
            validatorInfo: MOCK_VALIDATOR_INFO
          })
        })
      );
    });

    it('should handle validator not found', async () => {
      // Mock getValidatorInfo to return null (validator not found)
      setupPolygonServiceMethod('getValidatorInfo', null);
      
      await getValidatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Validator not found'),
          data: expect.objectContaining({
            error: expect.stringContaining('Validator not found')
          })
        })
      );
    });
    
    it('should handle missing validator ID from LLM extraction', async () => {
      // Mock LLM to return an error
      vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
        JSON.stringify({ error: 'Could not identify validator ID' })
      );
      
      await getValidatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockPolygonRpcService.getValidatorInfo).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Could not determine validator ID'),
          data: expect.objectContaining({
            error: expect.stringContaining('Could not determine validator ID')
          })
        })
      );
    });
    
    it('should handle errors from the service', async () => {
      const errorMessage = 'Network error when fetching validator';
      setupPolygonServiceMethod('getValidatorInfo', () => {
        throw new Error(errorMessage);
      });

      await getValidatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error fetching validator'),
          data: expect.objectContaining({
            error: expect.stringContaining(errorMessage)
          })
        })
      );
    });
  });
}); 
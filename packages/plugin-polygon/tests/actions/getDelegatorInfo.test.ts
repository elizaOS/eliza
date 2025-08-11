import { describe, it, beforeEach, vi, expect } from 'vitest';
import { getDelegatorInfoAction } from '../../src/actions/getDelegatorInfo';
import { PolygonRpcService } from '../../src/services/PolygonRpcService';
import type { Memory, State } from '@elizaos/core';
import { logger, parseJSONObjectFromText } from '@elizaos/core';
import { 
  mockRuntime, 
  mockPolygonRpcService,
  mockCreateGetDelegatorInfo
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

describe('getDelegatorInfoAction', () => {
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: ReturnType<typeof createMockCallback>;
  
  // Test constants
  const VALID_VALIDATOR_ID = 123;
  const VALID_DELEGATOR_ADDRESS = '0xDelegatorAddress';
  const MOCK_DELEGATOR_INFO = {
    delegatedAmount: BigInt('5000000000000000000'), // 5 MATIC
    pendingRewards: BigInt('100000000000000000'), // 0.1 MATIC
  };

  beforeEach(() => {
    resetCommonMocks();
    
    // Create standard test objects
    mockMessage = createMockMessage('Get my delegation info for validator 123');
    mockState = createMockState([mockMessage]);
    mockCallback = createMockCallback();
    
    // Setup standard return values for getDelegatorInfo
    const mockGetDelegatorInfo = mockCreateGetDelegatorInfo(MOCK_DELEGATOR_INFO);
    setupPolygonServiceMethod('getDelegatorInfo', mockGetDelegatorInfo);
    
    // Setup useModel mock for parameter extraction
    vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
      JSON.stringify({
        validatorId: VALID_VALIDATOR_ID,
        delegatorAddress: VALID_DELEGATOR_ADDRESS
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

      const isValid = await getDelegatorInfoAction.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(true);
    });

    it('should return false if POLYGON_RPC_URL is missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'POLYGON_RPC_URL') return null;
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });

      const isValid = await getDelegatorInfoAction.validate(mockRuntime, mockMessage, mockState);
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

      const isValid = await getDelegatorInfoAction.validate(mockRuntime, mockMessage, mockState);
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

      const isValid = await getDelegatorInfoAction.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('PolygonRpcService not initialized')
      );
    });
  });

  describe('handler', () => {
    it('should successfully retrieve delegator info with valid parameters from LLM', async () => {
      await getDelegatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      // Verify service was called with correct parameters
      expect(mockPolygonRpcService.getDelegatorInfo).toHaveBeenCalledWith(
        VALID_VALIDATOR_ID,
        VALID_DELEGATOR_ADDRESS
      );

      // Verify callback was called with success message
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Delegator Information'),
          actions: ['GET_DELEGATOR_INFO'],
          data: expect.objectContaining({
            validatorId: VALID_VALIDATOR_ID,
            delegatorAddress: VALID_DELEGATOR_ADDRESS,
            delegatorInfo: {
              delegatedAmount: MOCK_DELEGATOR_INFO.delegatedAmount.toString(),
              pendingRewards: MOCK_DELEGATOR_INFO.pendingRewards.toString()
            }
          })
        })
      );
    });

    it('should handle delegator not found', async () => {
      // Mock getDelegatorInfo to return null (delegator not found)
      setupPolygonServiceMethod('getDelegatorInfo', null);
      
      await getDelegatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('No delegation found'),
          data: expect.objectContaining({
            error: expect.stringContaining('No delegation found')
          })
        })
      );
    });
    
    it('should handle missing validator ID from LLM extraction', async () => {
      // Mock LLM to return an error
      vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
        JSON.stringify({ 
          error: 'Could not identify validator ID',
          delegatorAddress: VALID_DELEGATOR_ADDRESS 
        })
      );
      
      await getDelegatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockPolygonRpcService.getDelegatorInfo).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Could not determine validator ID'),
          data: expect.objectContaining({
            error: expect.stringContaining('Could not determine validator ID')
          })
        })
      );
    });
    
    it('should handle missing delegator address from LLM extraction', async () => {
      // Mock LLM to return an error
      vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
        JSON.stringify({ 
          validatorId: VALID_VALIDATOR_ID,
          error: 'Could not identify delegator address' 
        })
      );
      
      await getDelegatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockPolygonRpcService.getDelegatorInfo).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Could not determine delegator address'),
          data: expect.objectContaining({
            error: expect.stringContaining('Could not determine delegator address')
          })
        })
      );
    });
    
    it('should handle errors from the service', async () => {
      const errorMessage = 'Network error when fetching delegator info';
      setupPolygonServiceMethod('getDelegatorInfo', () => {
        throw new Error(errorMessage);
      });

      await getDelegatorInfoAction.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error fetching delegator'),
          data: expect.objectContaining({
            error: expect.stringContaining(errorMessage)
          })
        })
      );
    });
  });
}); 
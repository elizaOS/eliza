import { describe, it, beforeEach, vi, expect } from 'vitest';
import { restakeRewardsL1Action } from '../../src/actions/restakeRewardsL1';
import { PolygonRpcService } from '../../src/services/PolygonRpcService';
import type { Memory, State } from '@elizaos/core';
import { logger, parseJSONObjectFromText } from '@elizaos/core';
import { 
  mockRuntime, 
  mockPolygonRpcService
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

describe('restakeRewardsL1Action', () => {
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: ReturnType<typeof createMockCallback>;
  
  // Test constants
  const VALID_VALIDATOR_ID = 123;
  const MOCK_TX_HASH = '0xRestakeRewardsTxHash';

  beforeEach(() => {
    resetCommonMocks();
    
    // Create standard test objects
    mockMessage = createMockMessage('Restake rewards from validator 123');
    mockState = createMockState([mockMessage]);
    mockCallback = createMockCallback();
    
    // Setup standard return values
    setupPolygonServiceMethod('restakeRewards', MOCK_TX_HASH);
    
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
        if (key === 'PRIVATE_KEY') return 'test-pk';
        if (key === 'ETHEREUM_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });

      const isValid = await restakeRewardsL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(true);
    });

    it('should return false if PRIVATE_KEY is missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return null;
        if (key === 'ETHEREUM_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });

      const isValid = await restakeRewardsL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Required setting PRIVATE_KEY not configured')
      );
    });
    
    it('should return false if ETHEREUM_RPC_URL is missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-pk';
        if (key === 'ETHEREUM_RPC_URL') return null;
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });

      const isValid = await restakeRewardsL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Required setting ETHEREUM_RPC_URL not configured')
      );
    });
    
    it('should return false if POLYGON_PLUGINS_ENABLED is false or missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-pk';
        if (key === 'ETHEREUM_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return false;
        return null;
      });

      const isValid = await restakeRewardsL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Required setting POLYGON_PLUGINS_ENABLED not configured')
      );
    });
    
    it('should return false if PolygonRpcService is not available', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return 'test-pk';
        if (key === 'ETHEREUM_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });
      
      vi.spyOn(mockRuntime, 'getService').mockReturnValue(null);

      const isValid = await restakeRewardsL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('PolygonRpcService not initialized')
      );
    });
  });

  describe('handler', () => {
    it('should successfully restake rewards with valid validator ID from LLM', async () => {
      await restakeRewardsL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      // Verify service was called with correct parameters
      expect(mockPolygonRpcService.restakeRewards).toHaveBeenCalledWith(VALID_VALIDATOR_ID);

      // Verify callback was called with success message
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Successfully initiated rewards restaking'),
          actions: ['RESTAKE_REWARDS_L1'],
          data: expect.objectContaining({
            transactionHash: MOCK_TX_HASH,
            validatorId: VALID_VALIDATOR_ID,
            status: 'pending'
          })
        })
      );
    });

    it('should return an error if validatorId is missing after LLM extraction', async () => {
      // Mock LLM extraction with missing validatorId
      vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
        JSON.stringify({
          error: 'Could not identify validator ID'
        })
      );

      await restakeRewardsL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockPolygonRpcService.restakeRewards).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error restaking rewards'),
          data: expect.objectContaining({
            error: expect.stringContaining('Could not determine validator ID')
          })
        })
      );
    });
    
    it('should handle errors from the service', async () => {
      const errorMessage = 'Restaking failed: no rewards available';
      setupPolygonServiceMethod('restakeRewards', () => {
        throw new Error(errorMessage);
      });

      await restakeRewardsL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error restaking rewards'),
          data: expect.objectContaining({
            error: expect.stringContaining(errorMessage)
          })
        })
      );
    });
  });
}); 
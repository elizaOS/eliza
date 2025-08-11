import { describe, it, beforeEach, vi, expect } from 'vitest';
import { undelegateL1Action } from '../../src/actions/undelegateL1';
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

describe('undelegateL1Action', () => {
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: ReturnType<typeof createMockCallback>;
  
  // Test constants
  const VALID_VALIDATOR_ID = 123;
  const VALID_AMOUNT_WEI = '1000000000000000000'; // 1 MATIC in Wei
  const MOCK_TX_HASH = '0xUndelegateTxHash';

  beforeEach(() => {
    resetCommonMocks();
    
    // Create standard test objects
    mockMessage = createMockMessage('Undelegate 10 MATIC from validator 123');
    mockState = createMockState([mockMessage]);
    mockCallback = createMockCallback();
    
    // Setup standard return values
    setupPolygonServiceMethod('undelegate', MOCK_TX_HASH);
    
    // Setup useModel mock for parameter extraction
    vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
      JSON.stringify({
        validatorId: VALID_VALIDATOR_ID,
        amountWei: VALID_AMOUNT_WEI,
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

      const isValid = await undelegateL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(true);
    });

    it('should return false if PRIVATE_KEY is missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return null;
        if (key === 'ETHEREUM_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });

      const isValid = await undelegateL1Action.validate(mockRuntime, mockMessage, mockState);
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

      const isValid = await undelegateL1Action.validate(mockRuntime, mockMessage, mockState);
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

      const isValid = await undelegateL1Action.validate(mockRuntime, mockMessage, mockState);
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

      const isValid = await undelegateL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('PolygonRpcService not initialized')
      );
    });
  });

  describe('handler', () => {
    it('should successfully undelegate with valid parameters from LLM', async () => {
      await undelegateL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      // Verify service was called with correct parameters
      expect(mockPolygonRpcService.undelegate).toHaveBeenCalledWith(
        VALID_VALIDATOR_ID, 
        BigInt(VALID_AMOUNT_WEI)
      );

      // Verify callback was called with success message
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Successfully initiated undelegation'),
          actions: ['UNDELEGATE_L1'],
          data: expect.objectContaining({
            transactionHash: MOCK_TX_HASH,
            validatorId: VALID_VALIDATOR_ID,
            amount: BigInt(VALID_AMOUNT_WEI).toString(),
          })
        })
      );
    });

    it('should return an error if validatorId is missing after LLM extraction', async () => {
      // Mock LLM extraction with missing validatorId
      vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
        JSON.stringify({
          amountWei: VALID_AMOUNT_WEI,
        })
      );

      await undelegateL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockPolygonRpcService.undelegate).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error undelegating MATIC'),
          data: expect.objectContaining({
            error: expect.stringContaining('Validator ID is missing')
          })
        })
      );
    });

    it('should return an error if amountWei is missing after LLM extraction', async () => {
      // Mock LLM extraction with missing amountWei
      vi.spyOn(mockRuntime, 'useModel').mockResolvedValue(
        JSON.stringify({
          validatorId: VALID_VALIDATOR_ID,
        })
      );

      await undelegateL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockPolygonRpcService.undelegate).not.toHaveBeenCalled();
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error undelegating MATIC'),
          data: expect.objectContaining({
            error: expect.stringContaining('Amount is missing')
          })
        })
      );
    });
    
    it('should handle errors from the service', async () => {
      const errorMessage = 'Undelegation failed: insufficient staked amount';
      setupPolygonServiceMethod('undelegate', () => {
        throw new Error(errorMessage);
      });

      await undelegateL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Error undelegating MATIC'),
          data: expect.objectContaining({
            error: expect.stringContaining(errorMessage)
          })
        })
      );
    });
  });
}); 
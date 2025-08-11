import { describe, it, beforeEach, vi, expect } from 'vitest';
import { delegateL1Action } from '../../src/actions/delegateL1';
import { PolygonRpcService } from '../../src/services/PolygonRpcService';
import type { IAgentRuntime, Memory, State, Content, ModelType } from '@elizaos/core';
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

describe('delegateL1Action', () => {
  let mockMessage: Memory;
  let mockState: State;
  let mockCallback: ReturnType<typeof createMockCallback>;
  
  // Test constants
  const VALID_VALIDATOR_ID = 123;
  const VALID_AMOUNT_WEI = '1000000000000000000'; // 1 MATIC in Wei
  const MOCK_TX_HASH = '0xabcdef1234567890';

  beforeEach(() => {
    resetCommonMocks();
    
    // Create standard test objects
    mockMessage = createMockMessage('Delegate 10 MATIC to validator 123');
    mockState = createMockState([mockMessage]);
    mockCallback = createMockCallback();
    
    // Setup standard return values
    setupPolygonServiceMethod('delegate', MOCK_TX_HASH);
    
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

      const isValid = await delegateL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(true);
    });

    it('should return false if PRIVATE_KEY is missing', async () => {
      vi.spyOn(mockRuntime, 'getSetting').mockImplementation((key: string) => {
        if (key === 'PRIVATE_KEY') return null;
        if (key === 'ETHEREUM_RPC_URL') return 'test-rpc-url';
        if (key === 'POLYGON_PLUGINS_ENABLED') return true;
        return null;
      });

      const isValid = await delegateL1Action.validate(mockRuntime, mockMessage, mockState);
      expect(isValid).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Required setting PRIVATE_KEY not configured')
      );
    });
  });

  describe('handler', () => {
    it('should successfully delegate with valid parameters from LLM', async () => {
      await delegateL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      // Verify service was called with correct parameters
      expect(mockPolygonRpcService.delegate).toHaveBeenCalledWith(
        VALID_VALIDATOR_ID, 
        BigInt(VALID_AMOUNT_WEI)
      );

      // Verify callback was called with success message
      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Successfully initiated delegation'),
          actions: ['DELEGATE_L1'],
          data: expect.objectContaining({
            transactionHash: MOCK_TX_HASH,
            validatorId: VALID_VALIDATOR_ID,
            amount: BigInt(VALID_AMOUNT_WEI).toString(),
          })
        })
      );
    });

    it('should handle error from the service', async () => {
      const errorMessage = 'Delegation failed: insufficient funds';
      setupPolygonServiceMethod('delegate', () => {
        throw new Error(errorMessage);
      });

      await delegateL1Action.handler(
        mockRuntime, 
        mockMessage, 
        mockState, 
        undefined, 
        mockCallback
      );

      expect(mockCallback).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('Failed to delegate'),
          data: expect.objectContaining({
            error: expect.stringContaining(errorMessage)
          })
        })
      );
    });
  });
}); 
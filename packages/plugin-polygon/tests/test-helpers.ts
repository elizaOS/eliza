import { vi } from 'vitest';
import type { 
  IAgentRuntime, 
  Memory, 
  State, 
  Content,
  HandlerCallback 
} from '@elizaos/core';
import { mockRuntime, mockPolygonRpcService } from '../vitest.setup';

/**
 * Creates a standard mock message for action testing
 * @param text - The text content of the message
 * @returns A mock Memory object
 */
export function createMockMessage(text: string): Memory {
  return {
    id: 'test-msg-id',
    entityId: 'test-entity-id',
    roomId: 'test-room-id',
    timestamp: new Date().toISOString(),
    type: 'user_message',
    role: 'user',
    content: {
      text,
      source: 'test-source',
    },
  } as Memory;
}

/**
 * Creates mock state with recent messages
 * @param messages - The messages to include in state
 * @returns A mock State object
 */
export function createMockState(messages: Memory[]): State {
  return { 
    recentMessages: messages 
  } as unknown as State;
}

/**
 * Provides a standard setup for testing a service using a runtime
 * @param serviceName - The name of the service to mock
 * @param serviceInstance - The service instance to return
 */
export function setupRuntimeWithService(serviceName: string, serviceInstance: any): void {
  vi.spyOn(mockRuntime, 'getService').mockImplementation((serviceType: string) => {
    if (serviceType === serviceName) {
      return serviceInstance;
    }
    return null;
  });
}

/**
 * Sets up the standard polygon service mock with a specified method implementation
 * @param methodName - The name of the method to mock
 * @param implementation - The implementation function or return value
 */
export function setupPolygonServiceMethod(methodName: string, implementation: any): void {
  if (typeof implementation === 'function') {
    (mockPolygonRpcService as any)[methodName] = vi.fn().mockImplementation(implementation);
  } else {
    (mockPolygonRpcService as any)[methodName] = vi.fn().mockResolvedValue(implementation);
  }
  
  setupRuntimeWithService('PolygonRpcService', mockPolygonRpcService);
}

/**
 * Creates a standard mock callback
 * @returns A mock callback function
 */
export function createMockCallback(): HandlerCallback {
  return vi.fn();
}

/**
 * Helper to reset all commonly used mocks
 */
export function resetCommonMocks(): void {
  vi.clearAllMocks();
  
  // Reset mockRuntime methods
  vi.spyOn(mockRuntime, 'getSetting').mockClear();
  vi.spyOn(mockRuntime, 'getService').mockClear();
  vi.spyOn(mockRuntime, 'useModel').mockClear();
  
  // Clear mockPolygonRpcService methods
  Object.keys(mockPolygonRpcService).forEach(key => {
    if (typeof (mockPolygonRpcService as any)[key]?.mockClear === 'function') {
      (mockPolygonRpcService as any)[key].mockClear();
    }
  });
} 
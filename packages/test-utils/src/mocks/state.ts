/**
 * @fileoverview Mock implementations for State and related interfaces
 *
 * This module provides comprehensive mock implementations for state objects,
 * provider results, and state composition utilities.
 */

import type { ActionResult, ProviderResult, State } from '@elizaos/core';

/**
 * Type representing overrides for State mock creation
 */
export type MockStateOverrides = Partial<State>;

/**
 * Type representing overrides for ProviderResult mock creation
 */
export type MockProviderResultOverrides = Partial<ProviderResult>;

/**
 * Type representing overrides for ActionResult mock creation
 */
export type MockActionResultOverrides = Partial<ActionResult>;

/**
 * Create a comprehensive mock State object with intelligent defaults
 *
 * This function provides a fully-featured state mock that includes
 * realistic data structures and proper typing for agent context.
 *
 * @param overrides - Partial object to override specific properties
 * @returns Complete mock State object
 *
 * @example
 * ```typescript
 * import { createMockState } from '@elizaos/core/test-utils';
 *
 * const mockState = createMockState({
 *   values: { currentUser: 'john_doe' },
 *   data: { conversationLength: 5 }
 * });
 * ```
 */
export function createMockState(overrides: MockStateOverrides = {}): State {
  const baseState: State = {
    // Core state properties
    values: {
      currentTime: new Date().toISOString(),
      agentName: 'Test Agent',
      roomId: 'test-room-id',
      entityId: 'test-entity-id',
      userName: 'TestUser',
      conversationLength: 10,
      lastMessage: 'Hello, how can I help you?',
      ...overrides.values,
    },

    data: {
      providers: {
        TIME: { currentTime: new Date().toISOString() },
        CHARACTER: { agentName: 'Test Agent', bio: 'A helpful test assistant' },
        RECENT_MESSAGES: { messageCount: 5, lastSpeaker: 'user' },
      },
      actionResults: [],
      context: 'test conversation',
      ...overrides.data,
    },

    text: `[CONTEXT]
Current Time: ${new Date().toISOString()}
Agent: Test Agent
User: TestUser
Room: test-room-id
Recent conversation context available.
[/CONTEXT]`,

    // Additional properties that might be added dynamically
    ...overrides,
  };

  // Override text if explicitly provided
  if (overrides.text) {
    baseState.text = overrides.text;
  }

  return baseState;
}

/**
 * Create a mock ProviderResult object
 *
 * @param overrides - Partial object to override specific properties
 * @returns Complete mock ProviderResult object
 *
 * @example
 * ```typescript
 * import { createMockProviderResult } from '@elizaos/core/test-utils';
 *
 * const providerResult = createMockProviderResult({
 *   text: '[WEATHER] Current weather is sunny',
 *   values: { temperature: 72, conditions: 'sunny' }
 * });
 * ```
 */
export function createMockProviderResult(
  overrides: MockProviderResultOverrides = {}
): ProviderResult {
  const baseResult: ProviderResult = {
    values: {
      mockValue: 'test-value',
      timestamp: Date.now(),
      ...overrides.values,
    },
    data: {
      source: 'mock-provider',
      processed: true,
      ...overrides.data,
    },
    text: '[MOCK PROVIDER]\nMock provider context information\n[/MOCK PROVIDER]',
    ...overrides,
  };

  return baseResult;
}

/**
 * Create a mock ActionResult object
 *
 * @param overrides - Partial object to override specific properties
 * @returns Complete mock ActionResult object
 *
 * @example
 * ```typescript
 * import { createMockActionResult } from '@elizaos/core/test-utils';
 *
 * const actionResult = createMockActionResult({
 *   text: 'Action completed successfully',
 *   values: { success: true, id: 'action-123' }
 * });
 * ```
 */
export function createMockActionResult(overrides: MockActionResultOverrides = {}): ActionResult {
  const baseResult: ActionResult = {
    success: true,
    values: {
      success: true,
      actionId: 'test-action-id',
      timestamp: Date.now(),
      ...overrides.values,
    },
    data: {
      executionTime: 150,
      metadata: { source: 'mock-action' },
      ...overrides.data,
    },
    text: 'Mock action executed successfully',
    ...overrides,
  };

  return baseResult;
}

/**
 * Create a state with specific provider context
 *
 * @param providerName - Name of the provider
 * @param providerData - Data from the provider
 * @param overrides - Additional state overrides
 * @returns State with provider context
 */
export function createMockStateWithProvider(
  providerName: string,
  providerData: any,
  overrides: MockStateOverrides = {}
): State {
  return createMockState({
    data: {
      providers: {
        [providerName]: providerData,
        ...overrides.data?.providers,
      },
      ...overrides.data,
    },
    text: `[${providerName}]\n${JSON.stringify(providerData, null, 2)}\n[/${providerName}]`,
    ...overrides,
  });
}

/**
 * Create a state with action execution history
 *
 * @param actionResults - Array of action results
 * @param overrides - Additional state overrides
 * @returns State with action history
 */
export function createMockStateWithActions(
  actionResults: ActionResult[],
  overrides: MockStateOverrides = {}
): State {
  return createMockState({
    data: {
      actionResults,
      ...overrides.data,
    },
    values: {
      lastActionSuccess:
        actionResults.length > 0
          ? actionResults[actionResults.length - 1].values?.success
          : undefined,
      actionCount: actionResults.length,
      ...overrides.values,
    },
    ...overrides,
  });
}

/**
 * Create a state with realistic conversation context
 *
 * @param conversationHistory - Array of recent messages
 * @param currentUser - Current user name
 * @param overrides - Additional state overrides
 * @returns State with conversation context
 */
export function createMockConversationState(
  conversationHistory: string[] = ['Hello', 'Hi there!', 'How are you?'],
  currentUser: string = 'TestUser',
  overrides: MockStateOverrides = {}
): State {
  const recentContext = conversationHistory.slice(-3).join(' | ');

  return createMockState({
    values: {
      userName: currentUser,
      conversationLength: conversationHistory.length,
      lastMessage: conversationHistory[conversationHistory.length - 1],
      recentContext,
      ...overrides.values,
    },
    data: {
      providers: {
        RECENT_MESSAGES: {
          messages: conversationHistory,
          count: conversationHistory.length,
          lastSpeaker: conversationHistory.length % 2 === 0 ? 'agent' : 'user',
        },
        ...overrides.data?.providers,
      },
      ...overrides.data,
    },
    text: `[CONVERSATION CONTEXT]
User: ${currentUser}
Recent messages: ${recentContext}
Message count: ${conversationHistory.length}
[/CONVERSATION CONTEXT]`,
    ...overrides,
  });
}

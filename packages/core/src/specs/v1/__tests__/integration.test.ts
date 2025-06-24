import { describe, expect, it, mock } from 'bun:test';
import { ActionExample, fromV2ActionExample, toV2ActionExample } from '../actionExample';
import { Provider, fromV2Provider, toV2Provider } from '../provider';
import { State, toV2State } from '../state';
import { TemplateType, processTemplate } from '../templates';
import { asUUID } from '../uuid';

describe('Integration tests for v1 compatibility layer', () => {
  // Create UUIDs for testing
  const userId = asUUID('00000000-0000-0000-0000-000000000123');
  const agentId = asUUID('00000000-0000-0000-0000-000000000456');
  const roomId = asUUID('00000000-0000-0000-0000-000000000789');

  // Setup mock runtime
  const mockRuntime = {
    getSetting: mock().mockReturnValue('test-setting'),
    logger: { info: mock(), error: mock() },
  } as any;

  // Setup mock message
  const mockMessage = {
    id: asUUID('00000000-0000-0000-0000-000000000001'),
    roomId,
    content: { text: 'Test message' },
  } as any;

  it('should process a v1 state through a v2 provider and back', async () => {
    // Create a v1 state
    const v1State: State = {
      userId,
      agentId,
      roomId: '00000000-0000-0000-0000-000000000789',
      bio: 'Test bio',
      lore: 'Test lore',
      messageDirections: 'Test message directions',
      postDirections: 'Test post directions',
      actors: 'User, Agent',
      recentMessages: 'Some recent messages',
      recentMessagesData: [],
      text: 'Original state',
    };

    // Create a v1 provider
    const v1Provider: Provider = {
      name: 'testProvider',
      get: async (_runtime, _message, state) => {
        // Verify the state has correct v1 structure
        expect(state?.userId).toBe(userId);
        expect(state?.bio).toBe('Test bio');

        // Return a provider result
        return {
          text: `Provider processed state: ${state?.text}`,
          walletBalance: 123.45,
          userInfo: {
            name: 'Test User',
          },
        };
      },
    };

    // Convert to v2 provider
    const v2Provider = toV2Provider(v1Provider);

    // Convert state to v2
    const v2State = toV2State(v1State);

    // Use v2 provider with v2 state
    const result = (await v2Provider.get(mockRuntime, mockMessage, v2State)) as {
      text: string;
      walletBalance: number;
      userInfo: { name: string };
    };

    console.log('result', result);

    // Verify result
    expect(result.text).toBe('Provider processed state: Original state');
    expect(result.walletBalance).toBe(123.45);
    expect(result.userInfo.name).toBe('Test User');

    // Convert provider back to v1
    const v1ProviderAgain = fromV2Provider(v2Provider);

    // Use v1 provider with v1 state
    const resultAgain = await v1ProviderAgain.get(mockRuntime, mockMessage, v1State);

    // Verify result - note this will only be the text since fromV2Provider extracts text
    expect(resultAgain).toBe('Provider processed state: Original state');
  });

  it('should process ActionExample through v1->v2->v1 conversion', () => {
    // Create a v1 ActionExample
    const v1Example: ActionExample = {
      user: 'Test User',
      content: {
        text: 'Example content',
        action: 'test-action',
      },
    };

    // Convert to v2
    const v2Example = toV2ActionExample(v1Example);

    // Verify correct conversion
    expect(v2Example.name).toBe('Test User');
    expect(v2Example.content.text).toBe('Example content');

    // Convert back to v1
    const v1ExampleAgain = fromV2ActionExample(v2Example);

    // Verify round-trip preservation
    expect(v1ExampleAgain).toEqual(v1Example);
  });

  it('should process templates with state correctly', () => {
    // Create a template
    const template: TemplateType = ({ state }) => {
      return `Hello ${state.userId}, your balance is ${state.walletBalance}`;
    };

    // Create a state
    const state: State = {
      userId,
      agentId,
      bio: '',
      lore: '',
      messageDirections: '',
      postDirections: '',
      actors: '',
      recentMessages: '',
      recentMessagesData: [],
      walletBalance: 50,
    };

    // Process template
    const result = processTemplate(template, state);

    // Verify output
    expect(result).toBe(`Hello ${userId}, your balance is 50`);
  });
});

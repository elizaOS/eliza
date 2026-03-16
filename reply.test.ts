// Note: tests are structured to verify replyAction behavior in isolation.
import { replyAction } from './reply.ts';

describe('replyAction', () => {
  it('should validate correctly', async () => {
    const result = await replyAction.validate({});
    expect(result).toBe(true);
  });

  it('should handle first action correctly', async () => {
    const response = {
      content: {
        text: 'Initial response',
        thought: 'Initial thought',
      },
    };
    const result = await replyAction.handler({}, {}, {}, {}, undefined, [response]);
    expect(result).toEqual({
      text: 'Generated reply: Initial response',
      values: {
        success: true,
        responded: true,
        lastReply: 'Initial response',
        lastReplyTime: expect.any(Number),
        thoughtProcess: 'Initial thought',
      },
      data: {
        actionName: 'REPLY',
        response: {
          thought: 'Initial thought',
          text: 'Initial response',
          actions: ['REPLY'],
        },
        thought: 'Initial thought',
        messageGenerated: true,
      },
      success: true,
    });
  });

  it('should handle subsequent actions correctly', async () => {
    const previousResponse = {
      content: {
        providers: ['RECENT_MESSAGES'],
      },
    };
    const result = await replyAction.handler({}, {}, {}, { actionContext: { previousResults: [previousResponse] } }, undefined, []);
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('values.success', true);
  });

  describe('hasRequestedInState optimization', () => {
    it('should detect when a provider is requested in state', async () => {
      const state = {
        actionContext: {
          previousResults: [{
            content: {
              providers: ['TEST_PROVIDER']
            }
          }]
        }
      };
      const response = {
        content: {
          text: 'Test response',
          thought: 'Test thought',
          providers: ['TEST_PROVIDER']
        }
      };
      const result = await replyAction.handler({}, {}, {}, state, undefined, [response]);
      expect(result).toHaveProperty('values.success', true);
    });

    it('should handle missing provider requests correctly', async () => {
      const state = {
        actionContext: {
          previousResults: [{
            content: {
              providers: []
            }
          }]
        }
      };
      const response = {
        content: {
          text: 'Test response',
          thought: 'Test thought'
        }
      };
      const result = await replyAction.handler({}, {}, {}, state, undefined, [response]);
      expect(result).toHaveProperty('values.success', true);
    });

    it('should handle undefined state correctly', async () => {
      const result = await replyAction.handler({}, {}, {}, undefined, undefined, [{
        content: {
          text: 'Test response',
          thought: 'Test thought'
        }
      }]);
      expect(result).toHaveProperty('values.success', true);
    });
  });
});

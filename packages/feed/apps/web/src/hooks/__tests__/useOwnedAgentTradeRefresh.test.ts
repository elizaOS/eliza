import { describe, expect, it } from 'bun:test';
import { isAgentTradeActivityMessage } from '../ownedAgentTradeRefresh.shared';

describe('isAgentTradeActivityMessage', () => {
  it('accepts valid agent trade activity payloads', () => {
    expect(
      isAgentTradeActivityMessage({
        type: 'agent_trade',
        activity: {
          type: 'trade',
          data: {
            tradeId: 'trade-123',
            action: 'close',
          },
        },
      })
    ).toBe(true);
  });

  it('rejects non-trade agent activity payloads', () => {
    expect(
      isAgentTradeActivityMessage({
        type: 'agent_message',
        activity: {
          type: 'message',
        },
      })
    ).toBe(false);
  });

  it('rejects malformed payloads', () => {
    expect(
      isAgentTradeActivityMessage({
        type: 'agent_trade',
        activity: null,
      })
    ).toBe(false);
  });
});

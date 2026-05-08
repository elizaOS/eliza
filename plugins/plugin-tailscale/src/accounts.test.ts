import type { IAgentRuntime } from '@elizaos/core';
import { describe, expect, it, vi } from 'vitest';
import {
  readTailscaleAccounts,
  resolveTailscaleAccount,
  resolveTailscaleAccountId,
} from './accounts';
import { validateTailscaleConfig } from './environment';

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe('Tailscale account resolution', () => {
  it('keeps legacy settings as the default account', async () => {
    const rt = runtime({
      TAILSCALE_TAGS: 'tag:one,tag:two',
      TAILSCALE_FUNNEL: 'true',
    });

    expect(resolveTailscaleAccountId(rt)).toBe('default');
    expect(resolveTailscaleAccount(readTailscaleAccounts(rt), 'default')).toMatchObject({
      accountId: 'default',
      tags: 'tag:one,tag:two',
      funnel: 'true',
    });
    await expect(validateTailscaleConfig(rt)).resolves.toMatchObject({
      TAILSCALE_TAGS: ['tag:one', 'tag:two'],
      TAILSCALE_FUNNEL: true,
    });
  });

  it('resolves explicit accountId from TAILSCALE_ACCOUNTS', async () => {
    const rt = runtime({
      TAILSCALE_ACCOUNTS: JSON.stringify({
        cloud: {
          tags: ['tag:cloud'],
          funnel: false,
          backend: 'cloud',
          authKeyExpirySeconds: 120,
        },
      }),
    });

    expect(resolveTailscaleAccountId(rt, { accountId: 'cloud' })).toBe('cloud');
    await expect(validateTailscaleConfig(rt, 'cloud')).resolves.toMatchObject({
      TAILSCALE_TAGS: ['tag:cloud'],
      TAILSCALE_BACKEND: 'cloud',
      TAILSCALE_AUTH_KEY_EXPIRY_SECONDS: 120,
    });
  });
});

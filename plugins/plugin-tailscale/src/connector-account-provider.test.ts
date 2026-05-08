import { getConnectorAccountManager, type IAgentRuntime } from '@elizaos/core';
import { describe, expect, it, vi } from 'vitest';
import {
  createTailscaleConnectorAccountProvider,
  TAILSCALE_PROVIDER_ID,
} from './connector-account-provider';

function runtime(settings: Record<string, unknown>): IAgentRuntime {
  return {
    character: {},
    getSetting: vi.fn((key: string) => settings[key]),
  } as unknown as IAgentRuntime;
}

describe('Tailscale ConnectorAccountManager provider', () => {
  it('lists legacy settings as a default OWNER account', async () => {
    const rt = runtime({
      TAILSCALE_TAGS: 'tag:one,tag:two',
      TAILSCALE_FUNNEL: 'true',
    });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createTailscaleConnectorAccountProvider(rt));

    const accounts = await manager.listAccounts(TAILSCALE_PROVIDER_ID);
    const account = accounts[0];

    expect(accounts).toHaveLength(1);
    expect(account).toMatchObject({
      id: 'default',
      provider: TAILSCALE_PROVIDER_ID,
      role: 'OWNER',
      accessGate: 'open',
      status: 'connected',
      metadata: expect.objectContaining({
        isDefault: true,
        source: 'legacy',
        tags: 'tag:one,tag:two',
        funnel: 'true',
      }),
    });
    expect(account?.purpose).toEqual(expect.arrayContaining(['admin', 'automation']));
  });

  it('creates, patches, and deletes stored accounts without hiding legacy default', async () => {
    const rt = runtime({ TAILSCALE_TAGS: 'tag:default' });
    const manager = getConnectorAccountManager(rt);
    manager.registerProvider(createTailscaleConnectorAccountProvider(rt));

    const created = await manager.createAccount(TAILSCALE_PROVIDER_ID, {
      label: 'Team tailnet',
      role: 'TEAM',
      purpose: 'admin',
      status: 'connected',
    });

    expect(created).toMatchObject({
      provider: TAILSCALE_PROVIDER_ID,
      label: 'Team tailnet',
      role: 'TEAM',
      purpose: ['admin'],
      status: 'connected',
    });

    const listed = await manager.listAccounts(TAILSCALE_PROVIDER_ID);
    expect(listed.map((account) => account.id)).toEqual(
      expect.arrayContaining([created.id, 'default']),
    );

    const patched = await manager.patchAccount(TAILSCALE_PROVIDER_ID, created.id, {
      label: 'Renamed tailnet',
      displayHandle: 'team-tailnet',
    });
    expect(patched).toMatchObject({
      id: created.id,
      label: 'Renamed tailnet',
      displayHandle: 'team-tailnet',
      role: 'TEAM',
      purpose: ['admin'],
    });

    await expect(manager.deleteAccount(TAILSCALE_PROVIDER_ID, created.id)).resolves.toBe(true);
    await expect(manager.getAccount(TAILSCALE_PROVIDER_ID, created.id)).resolves.toBeNull();
  });
});

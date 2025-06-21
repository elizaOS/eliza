/// <reference types="vitest/globals" />
import { describe, expect, it, beforeEach } from 'vitest';
import { DummyTokenCreationService } from '../service';
import { type IAgentRuntime } from '@elizaos/core';

describe('DummyTokenCreationService', () => {
  let service: DummyTokenCreationService;
  const mockRuntime = {} as IAgentRuntime;

  beforeEach(async () => {
    service = new DummyTokenCreationService(mockRuntime);
    await service.start();
  });

  it('should be ready', async () => {
    const ready = await service.isReady();
    expect(ready).toBe(true);
  });

  it('should return a deployer address', async () => {
    const address = await service.getDeployerAddress();
    expect(address).toBe('DummyDeployerAddress_xxxxxxxxxxxx');
  });

  it('should create a new token', async () => {
    const tokenParams = {
      name: 'Test Token',
      symbol: 'TEST',
      description: 'A token for testing.',
      imageUrl: 'http://example.com/logo.png',
    };
    const result = await service.createToken(tokenParams);

    expect(result.success).toBe(true);
    expect(result.transactionId).toMatch(/^dummy-creation-tx-/);
    expect(result.tokenAddress).toMatch(/^dummy-token-/);
    expect(result.tokenData.name).toBe(tokenParams.name);
    expect(result.tokenData.symbol).toBe(tokenParams.symbol);
  });

  it('should get token info after creation', async () => {
    const tokenParams = {
      name: 'Another Token',
      symbol: 'ANT',
      description: 'Another token for testing.',
      imageUrl: 'http://example.com/logo2.png',
    };
    const { tokenAddress } = await service.createToken(tokenParams);
    const tokenInfo = await service.getTokenInfo(tokenAddress);

    expect(tokenInfo).not.toBeNull();
    expect(tokenInfo?.name).toBe(tokenParams.name);
    expect(tokenInfo?.symbol).toBe(tokenParams.symbol);
    expect(tokenInfo?.logoURI).toBe(tokenParams.imageUrl);
    expect((tokenInfo?.raw as any)?.description).toBe(tokenParams.description);
  });

  it('should return null for non-existent token info', async () => {
    const tokenInfo = await service.getTokenInfo('non-existent-address');
    expect(tokenInfo).toBeNull();
  });
});

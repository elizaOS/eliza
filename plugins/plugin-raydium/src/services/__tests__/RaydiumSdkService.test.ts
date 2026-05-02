/// <reference types="vitest/globals" />
import { vi, Mock, beforeEach, describe, it, expect } from 'vitest';
import { RaydiumSdkService } from '../RaydiumSdkService';
import { IAgentRuntime } from '@elizaos/core';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { Keypair } from '@solana/web3.js';

vi.mock('@raydium-io/raydium-sdk-v2', () => ({
  Raydium: {
    load: vi.fn(),
  },
  TxVersion: {
    V0: 0,
  }
}));

const mockRuntime = {
  getSetting: vi.fn(),
} as unknown as IAgentRuntime;

describe('RaydiumSdkService', () => {
  let sdkService: RaydiumSdkService;
  const owner = Keypair.generate();

  beforeEach(() => {
    vi.clearAllMocks();
    (mockRuntime.getSetting as Mock).mockReturnValue('https://api.mainnet-beta.solana.com');
    sdkService = new RaydiumSdkService(mockRuntime);
  });

  it('should throw an error if trying to access SDK before loading', () => {
    expect(() => sdkService.sdk).toThrow("RaydiumSdkService has not been initialized. Call load() first.");
  });

  it('should initialize the Raydium SDK on load', async () => {
    const mockSdkInstance = { 
      api: {},
      account: {
        fetchWalletTokenAccounts: vi.fn().mockResolvedValue(undefined)
      }
    } as any;
    (Raydium.load as Mock).mockResolvedValue(mockSdkInstance);

    await sdkService.load(owner);

    expect(Raydium.load).toHaveBeenCalledWith(expect.objectContaining({
        owner,
        connection: expect.any(Object),
        cluster: 'mainnet',
    }));
    expect(sdkService.sdk).toBe(mockSdkInstance);
    expect(sdkService.owner).toBe(owner);
  });

  it('should not re-initialize if already loaded', async () => {
    const mockSdkInstance = { 
      api: {},
      account: {
        fetchWalletTokenAccounts: vi.fn().mockResolvedValue(undefined)
      }
    } as any;
    (Raydium.load as Mock).mockResolvedValue(mockSdkInstance);
    await sdkService.load(owner);
    await sdkService.load(owner);
    expect(Raydium.load).toHaveBeenCalledTimes(1);
  });

  it('should detect devnet cluster from RPC URL', async () => {
    (mockRuntime.getSetting as Mock).mockReturnValue('https://api.devnet.solana.com');
    const mockSdkInstance = { 
      api: {},
      account: {
        fetchWalletTokenAccounts: vi.fn().mockResolvedValue(undefined)
      }
    } as any;
    (Raydium.load as Mock).mockResolvedValue(mockSdkInstance);
    
    await sdkService.load(owner);
    
    expect(Raydium.load).toHaveBeenCalledWith(expect.objectContaining({
      cluster: 'devnet',
    }));
  });
}); 
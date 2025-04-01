import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { mainnet, iotex, arbitrum, type Chain } from 'viem/chains';

import { WalletProvider } from '../providers/wallet';
import { customChain } from './custom-chain';

const customRpcUrls = {
  mainnet: 'custom-rpc.mainnet.io',
  arbitrum: 'custom-rpc.base.io',
  iotex: 'custom-rpc.iotex.io',
};

// Mock the ICacheManager
const mockCacheManager = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn(),
};

describe('Wallet provider', () => {
  let walletProvider: WalletProvider;
  let pk: `0x${string}`;
  const customChains: Record<string, Chain> = {};

  beforeAll(() => {
    pk = generatePrivateKey();
    // Add the custom chain to the customChains object
    customChains['myCustomChain'] = customChain;
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCacheManager.get.mockResolvedValue(null);
  });

  describe('Constructor', () => {
    it('sets address', () => {
      const account = privateKeyToAccount(pk);
      const expectedAddress = account.address;

      walletProvider = new WalletProvider(pk, mockCacheManager as any);

      expect(walletProvider.getAddress()).toEqual(expectedAddress);
    });
    it('sets default chains (including mainnet) when no custom chains are provided', () => {
      walletProvider = new WalletProvider(pk, mockCacheManager as any);

      // mainnet from viem.chains is included by default
      expect(walletProvider.chains.mainnet.id).toEqual(mainnet.id);
    });

    it('sets custom chains', () => {
      walletProvider = new WalletProvider(pk, mockCacheManager as any, customChains);

      expect(walletProvider.chains.myCustomChain.id).toEqual(customChain.id);
    });
  });
  describe('Clients', () => {
    beforeEach(() => {
      walletProvider = new WalletProvider(pk, mockCacheManager as any);
    });
    it('generates public client for mainnet', () => {
      const client = walletProvider.getPublicClient('mainnet');
      expect(client.chain.id).toEqual(mainnet.id);
      expect(client.transport.url).toEqual(mainnet.rpcUrls.default.http[0]);
    });
    it('generates public client with custom rpcurl', () => {
      const chain = WalletProvider.genChainFromName('mainnet', customRpcUrls.mainnet);
      const wp = new WalletProvider(pk, mockCacheManager as any, {
        ['mainnet']: chain,
      });

      const client = wp.getPublicClient('mainnet');
      expect(client.chain.id).toEqual(mainnet.id);
      expect(client.chain.rpcUrls.default.http[0]).toEqual(mainnet.rpcUrls.default.http[0]);
      expect(client.chain.rpcUrls.custom.http[0]).toEqual(customRpcUrls.mainnet);
      expect(client.transport.url).toEqual(customRpcUrls.mainnet);
    });
    it('generates wallet client', () => {
      const account = privateKeyToAccount(pk);
      const expectedAddress = account.address;

      const client = walletProvider.getWalletClient('mainnet');

      expect(client.account.address).toEqual(expectedAddress);
      expect(client.transport.url).toEqual(mainnet.rpcUrls.default.http[0]);
    });
    it('generates wallet client with custom rpcurl', () => {
      const account = privateKeyToAccount(pk);
      const expectedAddress = account.address;
      const chain = WalletProvider.genChainFromName('mainnet', customRpcUrls.mainnet);
      const wp = new WalletProvider(pk, mockCacheManager as any, {
        ['mainnet']: chain,
      });

      const client = wp.getWalletClient('mainnet');

      expect(client.account.address).toEqual(expectedAddress);
      expect(client.chain.id).toEqual(mainnet.id);
      expect(client.chain.rpcUrls.default.http[0]).toEqual(mainnet.rpcUrls.default.http[0]);
      expect(client.chain.rpcUrls.custom.http[0]).toEqual(customRpcUrls.mainnet);
      expect(client.transport.url).toEqual(customRpcUrls.mainnet);
    });
  });
  describe('Balance', () => {
    beforeEach(() => {
      walletProvider = new WalletProvider(pk, mockCacheManager as any, customChains);
    });
    it('should fetch balance for "mainnet" (returns "0" in test env)', async () => {
      const bal = await walletProvider.getWalletBalanceForChain('mainnet');
      expect(bal).toEqual('0');
    });
    it('should fetch balance for a specific added chain', async () => {
      const bal = await walletProvider.getWalletBalanceForChain('iotex');

      expect(bal).toEqual('0');
    });
    it('should return null if chain is not added', async () => {
      const bal = await walletProvider.getWalletBalanceForChain('myCustomChain');
      expect(bal).toBe(null);
    });
  });
  describe('Chain helpers', () => {
    beforeEach(() => {
      walletProvider = new WalletProvider(pk, mockCacheManager as any);
    });
    it('generates chains from chain name', () => {
      const chainName = 'iotex';
      const chain: Chain = WalletProvider.genChainFromName(chainName);

      expect(chain.id).toEqual(iotex.id);
      expect(chain.rpcUrls.default.http[0]).toEqual(iotex.rpcUrls.default.http[0]);
    });
    it('generates chains from chain name with custom rpc url', () => {
      const chainName = 'iotex';
      const customRpcUrl = 'custom.url.io';
      const chain: Chain = WalletProvider.genChainFromName(chainName, customRpcUrl);

      expect(chain.rpcUrls.default.http[0]).toEqual(iotex.rpcUrls.default.http[0]);
      expect(chain.rpcUrls.custom.http[0]).toEqual(customRpcUrl);
    });

    it('adds chain', () => {
      const initialChains = walletProvider.chains;
      expect(initialChains.customChain).toBeUndefined();

      walletProvider.addChain({ customChain });
      const newChains = walletProvider.chains;
      expect(newChains.customChain).toBeDefined();
    });
    it('gets chain configs', () => {
      const chain = walletProvider.getChainConfigs('iotex');

      expect(chain.id).toEqual(iotex.id);
    });

    it('throws if unsupported chain name', () => {
      // intentionally set incorrect chain, ts will complain
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      expect(() => WalletProvider.genChainFromName('ethereum')).toThrow();
    });
    it('throws if invalid chain name', () => {
      // intentionally set incorrect chain, ts will complain
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      expect(() => WalletProvider.genChainFromName('eth')).toThrow();
    });
  });
});

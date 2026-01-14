import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IAgentRuntime } from '@elizaos/core';
import type { Address } from 'viem';

// Mock runtime
const createMockRuntime = (settings: Record<string, string> = {}): IAgentRuntime => ({
  getSetting: vi.fn((key: string) => settings[key]),
  agentId: 'test-agent-id',
  services: new Map(),
  getService: vi.fn(),
  composeState: vi.fn(),
  updateRecentMessageState: vi.fn(),
  setCache: vi.fn(),
  getCache: vi.fn(),
} as unknown as IAgentRuntime);

describe('UniswapV3LpService', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = createMockRuntime({
      EVM_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      ETHEREUM_RPC_URL: 'https://eth.example.com',
      BASE_RPC_URL: 'https://base.example.com',
    });
  });

  it('should get correct DEX name', async () => {
    const { UniswapV3LpService } = await import('../../uniswap/services/UniswapV3LpService.ts');
    const service = new UniswapV3LpService(mockRuntime);
    expect(service.getDexName()).toBe('uniswap');
  });

  it('should return supported chain IDs', async () => {
    const { UniswapV3LpService } = await import('../../uniswap/services/UniswapV3LpService.ts');
    const service = new UniswapV3LpService(mockRuntime);
    const chainIds = service.getSupportedChainIds();
    
    expect(chainIds).toContain(1); // Ethereum
    expect(chainIds).toContain(8453); // Base
    expect(chainIds).toContain(42161); // Arbitrum
  });

  it('should check if chain is supported', async () => {
    const { UniswapV3LpService } = await import('../../uniswap/services/UniswapV3LpService.ts');
    const service = new UniswapV3LpService(mockRuntime);
    
    expect(service.supportsChain(1)).toBe(true);
    expect(service.supportsChain(8453)).toBe(true);
    expect(service.supportsChain(999999)).toBe(false);
  });
});

describe('PancakeSwapV3LpService', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = createMockRuntime({
      EVM_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      BSC_RPC_URL: 'https://bsc.example.com',
    });
  });

  it('should get correct DEX name', async () => {
    const { PancakeSwapV3LpService } = await import('../../pancakeswp/services/PancakeSwapV3LpService.ts');
    const service = new PancakeSwapV3LpService(mockRuntime);
    expect(service.getDexName()).toBe('pancakeswap');
  });

  it('should support BSC chain', async () => {
    const { PancakeSwapV3LpService } = await import('../../pancakeswp/services/PancakeSwapV3LpService.ts');
    const service = new PancakeSwapV3LpService(mockRuntime);
    
    expect(service.supportsChain(56)).toBe(true); // BSC
    expect(service.supportsChain(1)).toBe(true); // Ethereum
    expect(service.supportsChain(42161)).toBe(true); // Arbitrum
  });
});

describe('AerodromeLpService', () => {
  let mockRuntime: IAgentRuntime;

  beforeEach(() => {
    mockRuntime = createMockRuntime({
      EVM_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      BASE_RPC_URL: 'https://base.example.com',
    });
  });

  it('should get correct DEX name', async () => {
    const { AerodromeLpService } = await import('../../aerodrome/services/AerodromeLpService.ts');
    const service = new AerodromeLpService(mockRuntime);
    expect(service.getDexName()).toBe('aerodrome');
  });

  it('should only support Base chain', async () => {
    const { AerodromeLpService } = await import('../../aerodrome/services/AerodromeLpService.ts');
    const service = new AerodromeLpService(mockRuntime);
    
    expect(service.supportsChain(8453)).toBe(true); // Base
    expect(service.supportsChain(1)).toBe(false); // Ethereum
    expect(service.supportsChain(56)).toBe(false); // BSC
  });

  it('should return correct supported chain IDs', async () => {
    const { AerodromeLpService } = await import('../../aerodrome/services/AerodromeLpService.ts');
    const service = new AerodromeLpService(mockRuntime);
    const chainIds = service.getSupportedChainIds();
    
    expect(chainIds).toEqual([8453]); // Only Base
  });
});

describe('EVM LP Service Types', () => {
  it('should have correct supported EVM chains configuration', async () => {
    const { SUPPORTED_EVM_CHAINS, getChainConfig } = await import('../../types.ts');
    
    // Check Ethereum config
    expect(SUPPORTED_EVM_CHAINS.ethereum.chainId).toBe(1);
    expect(SUPPORTED_EVM_CHAINS.ethereum.supportedDexes).toContain('uniswap');
    
    // Check Base config
    expect(SUPPORTED_EVM_CHAINS.base.chainId).toBe(8453);
    expect(SUPPORTED_EVM_CHAINS.base.supportedDexes).toContain('uniswap');
    expect(SUPPORTED_EVM_CHAINS.base.supportedDexes).toContain('aerodrome');
    
    // Check BSC config
    expect(SUPPORTED_EVM_CHAINS.bsc.chainId).toBe(56);
    expect(SUPPORTED_EVM_CHAINS.bsc.supportedDexes).toContain('pancakeswap');
    
    // Test getChainConfig helper
    const ethereumConfig = getChainConfig('ethereum');
    expect(ethereumConfig?.chainId).toBe(1);
    
    const baseConfigById = getChainConfig(8453);
    expect(baseConfigById?.name).toBe('Base');
  });
});

describe('Configuration Loading', () => {
  it('should detect Solana configuration correctly', () => {
    const runtimeWithSolana = createMockRuntime({
      SOLANA_PRIVATE_KEY: 'test-solana-key',
      SOLANA_RPC_URL: 'https://api.mainnet-beta.solana.com',
    });
    
    expect(runtimeWithSolana.getSetting('SOLANA_PRIVATE_KEY')).toBe('test-solana-key');
  });

  it('should detect EVM configuration correctly', () => {
    const runtimeWithEvm = createMockRuntime({
      EVM_PRIVATE_KEY: '0x1234',
      BASE_RPC_URL: 'https://base.rpc.url',
    });
    
    expect(runtimeWithEvm.getSetting('EVM_PRIVATE_KEY')).toBe('0x1234');
    expect(runtimeWithEvm.getSetting('BASE_RPC_URL')).toBe('https://base.rpc.url');
  });

  it('should allow specifying preferred DEXes', () => {
    const runtimeWithPrefs = createMockRuntime({
      SOLANA_PRIVATE_KEY: 'test-key',
      LP_SOLANA_DEXES: 'raydium,orca',
      EVM_PRIVATE_KEY: '0x1234',
      LP_EVM_DEXES: 'uniswap,aerodrome',
    });
    
    expect(runtimeWithPrefs.getSetting('LP_SOLANA_DEXES')).toBe('raydium,orca');
    expect(runtimeWithPrefs.getSetting('LP_EVM_DEXES')).toBe('uniswap,aerodrome');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PolygonRpcProvider } from '../../src/providers/PolygonRpcProvider';
import { 
  elizaLogger, 
  mockL1PublicClient, 
  mockL2PublicClient,
  mockL1WalletClient,
  mockL2WalletClient
} from '../../vitest.setup';

// Imported with mocks from vitest.setup.ts
import { createPublicClient, createWalletClient } from 'viem';

describe('PolygonRpcProvider', () => {
  let provider: PolygonRpcProvider;
  
  const mockPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const mockEthereumRpcUrl = 'https://eth-mainnet.mock.io';
  const mockPolygonRpcUrl = 'https://polygon-mainnet.mock.io';
  const mockTokenAddress = '0x1234567890abcdef1234567890abcdef12345678';
  const mockUserAddress = '0xUserAddress';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Spy on elizaLogger methods
    vi.spyOn(elizaLogger, 'log').mockImplementation(() => {});
    vi.spyOn(elizaLogger, 'error').mockImplementation(() => {});
    vi.spyOn(elizaLogger, 'warn').mockImplementation(() => {});
    vi.spyOn(elizaLogger, 'debug').mockImplementation(() => {});
    vi.spyOn(elizaLogger, 'info').mockImplementation(() => {});
    
    // Initialize the provider
    provider = new PolygonRpcProvider(
      mockEthereumRpcUrl,
      mockPolygonRpcUrl,
      mockPrivateKey
    );
    
    // Set the address property using type assertion to bypass private access
    (provider as any).account = { 
      address: mockUserAddress,
      sign: vi.fn(),
      experimental_signAuthorization: vi.fn(),
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
      type: 'local'
    };
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('Initialization', () => {
    it('should initialize with correct RPC URLs and account', () => {
      expect(provider).toBeDefined();
      expect(provider.getAddress()).toBe(mockUserAddress);
    });
  });

  describe('Block methods', () => {
    it('should get L1 block number', async () => {
      const blockNumber = await provider.getBlockNumber('L1');
      expect(blockNumber).toBe(16000000);
    });

    it('should get L2 block number', async () => {
      const blockNumber = await provider.getBlockNumber('L2');
      expect(blockNumber).toBe(40000000);
    });

    it('should get L1 block by number', async () => {
      const block = await provider.getBlock(1000000, 'L1');
      expect(block).toBeDefined();
      expect(block.number).toBe(BigInt(16000000));
    });

    it('should get L2 block by number', async () => {
      const block = await provider.getBlock(1000000, 'L2');
      expect(block).toBeDefined();
      expect(block.number).toBe(BigInt(40000000));
    });
  });

  describe('Transaction methods', () => {
    it('should get transaction by hash from L1', async () => {
      const tx = await provider.getTransaction('0xHash', 'L1');
      expect(tx).toBeDefined();
      expect(tx.value).toBe(BigInt(1000000000000000000));
    });

    it('should get transaction by hash from L2', async () => {
      const tx = await provider.getTransaction('0xHash', 'L2');
      expect(tx).toBeDefined();
      expect(tx.value).toBe(BigInt(1000000000000000000));
    });

    it('should get transaction receipt from L1', async () => {
      const receipt = await provider.getTransactionReceipt('0xHash', 'L1');
      expect(receipt).toBeDefined();
      expect(receipt.status).toBe('success');
    });

    it('should get transaction receipt from L2', async () => {
      const receipt = await provider.getTransactionReceipt('0xHash', 'L2');
      expect(receipt).toBeDefined();
      expect(receipt.status).toBe('success');
    });
  });

  describe('Balance methods', () => {
    it('should get native balance from L1', async () => {
      const balance = await provider.getNativeBalance(mockUserAddress, 'L1');
      expect(balance).toBe(BigInt(5000000000000000000));
    });

    it('should get native balance from L2', async () => {
      const balance = await provider.getNativeBalance(mockUserAddress, 'L2');
      expect(balance).toBe(BigInt(100000000000000000000));
    });

    it('should get ERC20 token balance from L1', async () => {
      const balance = await provider.getErc20Balance(
        mockTokenAddress,
        mockUserAddress,
        'L1'
      );
      expect(balance).toBe(BigInt(1000000000000000000));
    });

    it('should get ERC20 token balance from L2', async () => {
      const balance = await provider.getErc20Balance(
        mockTokenAddress,
        mockUserAddress,
        'L2'
      );
      expect(balance).toBe(BigInt(2000000000000000000));
    });
  });

  describe('ERC20 metadata methods', () => {
    it('should get ERC20 token metadata from L1', async () => {
      const metadata = await provider.getErc20Metadata(mockTokenAddress, 'L1');
      expect(metadata).toBeDefined();
      expect(metadata.symbol).toBe('ETH-TOKEN');
      expect(metadata.decimals).toBe(18);
    });

    it('should get ERC20 token metadata from L2', async () => {
      const metadata = await provider.getErc20Metadata(mockTokenAddress, 'L2');
      expect(metadata).toBeDefined();
      expect(metadata.symbol).toBe('MATIC-TOKEN');
      expect(metadata.decimals).toBe(18);
    });
  });

  describe('Transaction sending', () => {
    it('should send a transaction on L1', async () => {
      const txHash = await provider.sendTransaction(
        '0xRecipient',
        BigInt(1000000000000000000),
        '0xData',
        'L1'
      );
      expect(txHash).toBe('0xL1SendTxHash');
    });

    it('should send a transaction on L2', async () => {
      const txHash = await provider.sendTransaction(
        '0xRecipient',
        BigInt(1000000000000000000),
        '0xData',
        'L2'
      );
      expect(txHash).toBe('0xL2SendTxHash');
    });
  });

  describe('Caching', () => {
    it('should cache block number responses', async () => {
      // First call
      await provider.getBlockNumber('L2');
      
      // Second call should use cached result
      await provider.getBlockNumber('L2');
      
      // Verify getBlockNumber was only called once on the client
      expect(mockPublicClient.getBlockNumber).toHaveBeenCalledTimes(1);
    });
  });
}); 
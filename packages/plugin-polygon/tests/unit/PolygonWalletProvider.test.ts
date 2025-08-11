import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WalletProvider } from '../../src/providers/PolygonWalletProvider';
import { 
  mockL1PublicClient,
  mockL1WalletClient,
  mockTestClient
} from '../../vitest.setup';

// Import the mocked functions from vitest.setup.ts
import { createPublicClient, createWalletClient, createTestClient } from 'viem';

describe('PolygonWalletProvider', () => {
  let provider: WalletProvider;
  
  const mockPrivateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  const mockUserAddress = '0xUserAddress';

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Configure the mock functions to use our standardized mocks
    (createPublicClient as any).mockReturnValue(mockL1PublicClient);
    (createWalletClient as any).mockReturnValue(mockL1WalletClient);
    (createTestClient as any).mockReturnValue(mockTestClient);
    
    // Initialize the provider with private key
    provider = new WalletProvider(mockPrivateKey);
    
    // Add account property for testing with type assertion
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
    it('should initialize with private key', () => {
      expect(provider).toBeDefined();
      expect(provider.getAddress()).toBe('0xUserAddress');
    });

    it('should initialize with custom chains', () => {
      const customChains = {
        testnet: {
          id: 80001,
          name: 'Polygon Mumbai',
          network: 'mumbai',
          nativeCurrency: { name: 'MATIC', symbol: 'MATIC', decimals: 18 },
          rpcUrls: {
            default: { http: ['https://rpc-mumbai.maticvigil.com'] },
          },
        },
      };
      
      const walletProviderWithChains = new WalletProvider(mockPrivateKey, customChains);
      // Add account property for testing with type assertion
      (walletProviderWithChains as any).account = { 
        address: '0xUserAddress',
        sign: vi.fn(),
        experimental_signAuthorization: vi.fn(),
        signMessage: vi.fn(),
        signTransaction: vi.fn(),
        signTypedData: vi.fn(),
        type: 'local'
      };
      
      expect(walletProviderWithChains.chains.testnet).toBeDefined();
      expect(walletProviderWithChains.chains.testnet.id).toBe(80001);
    });
  });

  describe('Client getters', () => {
    it('should get public client for a chain', () => {
      vi.spyOn(provider, 'getPublicClient').mockReturnValue(mockL1PublicClient as unknown as any);
      const publicClient = provider.getPublicClient('mainnet');
      expect(publicClient).toBeDefined();
    });

    it('should get wallet client for a chain', () => {
      vi.spyOn(provider, 'getWalletClient').mockReturnValue(mockL1WalletClient as unknown as any);
      const walletClient = provider.getWalletClient('mainnet');
      expect(walletClient).toBeDefined();
      expect(walletClient.account?.address).toBe('0xUserAddress');
    });

    it('should get test client', () => {
      vi.spyOn(provider, 'getTestClient').mockReturnValue(mockTestClient as unknown as any);
      const testClient = provider.getTestClient();
      expect(testClient).toBeDefined();
    });
  });

  describe('Chain management', () => {
    it('should get chain configs', () => {
      const chain = provider.getChainConfigs('mainnet');
      expect(chain).toBeDefined();
      expect(chain.id).toBe(1);
    });

    it('should add a new chain', () => {
      const newChain = {
        customChain: {
          id: 12345,
          name: 'Custom Chain',
          network: 'custom',
          nativeCurrency: { name: 'Custom', symbol: 'CUST', decimals: 18 },
          rpcUrls: {
            default: { http: ['https://custom-chain.rpc'] },
          },
        },
      };
      
      provider.addChain(newChain);
      expect(provider.chains.customChain).toBeDefined();
      expect(provider.chains.customChain.id).toBe(12345);
    });

    it('should switch chain', () => {
      // Initial chain
      provider.switchChain('mainnet');
      expect(provider.getCurrentChain().id).toBe(1);
      
      // Switch to different chain
      provider.switchChain('polygon');
      expect(provider.getCurrentChain().id).toBe(137);
    });

    it('should switch to a new chain that needs to be added', () => {
      // Generate a chain from name and switch to it
      provider.switchChain('polygon');
      expect(provider.getCurrentChain().id).toBe(137);
    });
  });

  describe('Balance operations', () => {
    it('should get wallet balance for current chain', async () => {
      vi.spyOn(provider, 'getWalletBalance').mockResolvedValue('2.0');
      const balance = await provider.getWalletBalance();
      expect(balance).toBe('2.0');
    });

    it('should get wallet balance for specified chain', async () => {
      vi.spyOn(provider, 'getWalletBalanceForChain').mockResolvedValue('2.0');
      const balance = await provider.getWalletBalanceForChain('polygon');
      expect(balance).toBe('2.0');
    });
  });

  describe('Static chain helpers', () => {
    it('should generate chain from name', () => {
      const chain = WalletProvider.genChainFromName('polygon');
      expect(chain).toBeDefined();
      expect(chain.id).toBe(137);
    });

    it('should generate chain from name with custom RPC URL', () => {
      const customRpcUrl = 'https://custom-polygon-rpc.io';
      const chain = WalletProvider.genChainFromName('polygon', customRpcUrl);
      
      expect(chain).toBeDefined();
      expect(chain.id).toBe(137);
      expect(chain.rpcUrls.custom.http[0]).toBe(customRpcUrl);
    });

    it('should throw on invalid chain name', () => {
      expect(() => WalletProvider.genChainFromName('invalid-chain')).toThrow();
    });
  });
}); 
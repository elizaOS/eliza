/**
 * Global test setup for Polygon plugin
 * This file centralizes all mocks used across tests
 */

import { vi } from 'vitest';

// Mock logger to avoid dependency on @elizaos/core
export const logger = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock elizaLogger for consistency with @elizaos/core
export const elizaLogger = logger;

// Mock @elizaos/core
export const mockRuntime = {
  getSetting: vi.fn().mockImplementation((key) => {
    const settings = {
      'ETHEREUM_RPC_URL': 'https://mainnet.infura.io/v3/mock-key',
      'POLYGON_RPC_URL': 'https://polygon-mainnet.infura.io/v3/mock-key',
      'PRIVATE_KEY': '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      'POLYGONSCAN_KEY': 'MOCK_POLYGONSCAN_KEY',
    };
    return settings[key] || null;
  }),
  getService: vi.fn().mockReturnValue(null),
  registerAction: vi.fn(),
  registerService: vi.fn(),
  useModel: vi.fn().mockResolvedValue('{"tokenAddress":"0x1234567890abcdef1234567890abcdef12345678","amount":"1.5"}'),
  getConfig: vi.fn().mockImplementation((key, defaultValue) => {
    const configs = {
      'polygon.privateKey': '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      'polygon.ethereumRpcUrl': 'https://mainnet.infura.io/v3/mock-key',
      'polygon.polygonRpcUrl': 'https://polygon-mainnet.infura.io/v3/mock-key',
      'polygon.polygonscanKey': 'MOCK_POLYGONSCAN_KEY',
    };
    return configs[key] || defaultValue;
  }),
};

// Mock Node-Cache
vi.mock('node-cache', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      get: vi.fn().mockReturnValue(null),
      set: vi.fn(),
      del: vi.fn(),
    }))
  };
});

// Mock viem with combined implementation for different test files
vi.mock('viem', () => {
  return {
    createPublicClient: vi.fn(),
    createWalletClient: vi.fn(),
    createTestClient: vi.fn(),
    formatUnits: vi.fn().mockReturnValue('2.0'),
    parseUnits: vi.fn().mockReturnValue(BigInt(2000000000000000000)),
    formatEther: vi.fn().mockReturnValue('2.0'),
    parseEther: vi.fn().mockReturnValue(BigInt(2000000000000000000)),
    http: vi.fn().mockImplementation((url) => {
      // Return a transport object with the URL property for later matching
      return { url };
    }),
    fallback: vi.fn().mockImplementation((transports) => transports[0]),
    toHex: vi.fn().mockImplementation((value) => `0x${value.toString(16)}`),
  };
});

// Mock viem/accounts
vi.mock('viem/accounts', () => {
  return {
    privateKeyToAccount: vi.fn().mockReturnValue({
      address: '0xUserAddress',
      signMessage: vi.fn(),
      signTransaction: vi.fn(),
      signTypedData: vi.fn(),
    }),
  };
});

// Import viem functions with type casting to avoid TypeScript errors
const { createPublicClient, createWalletClient, createTestClient } = vi.hoisted(() => ({
  createPublicClient: vi.fn() as any,
  createWalletClient: vi.fn() as any,
  createTestClient: vi.fn() as any,
}));

// Mock contract instances and responses for bridge tests
export const mockAllowanceValue = BigInt(0);
export const mockApprovalTxHash = '0xApprovalTxHash';
export const mockDepositTxHash = '0xDepositErc20TxHash';
export const mockSenderAddress = '0xUserAddress';

export const mockApprovalTx = {
  hash: '0xApprovalTxHash',
  wait: vi.fn().mockResolvedValue({
    status: 1,
    transactionHash: '0xApprovalTxHash',
    events: [],
    logs: []
  })
};

export const mockDepositTx = {
  hash: '0xDepositErc20TxHash',
  wait: vi.fn().mockResolvedValue({
    status: 1,
    transactionHash: '0xDepositErc20TxHash',
    events: [],
    logs: []
  })
};

export const mockDepositEthTx = {
  hash: '0xDepositEthTxHash',
  wait: vi.fn().mockResolvedValue({
    status: 1,
    transactionHash: '0xDepositEthTxHash',
    events: [],
    logs: []
  })
};

// Mock ERC20 contract
export const mockERC20Contract = {
  allowance: vi.fn().mockResolvedValue(BigInt(0)),
  approve: vi.fn().mockResolvedValue(mockApprovalTx),
  balanceOf: vi.fn().mockResolvedValue(BigInt(1000000000000000000n)),
  decimals: vi.fn().mockResolvedValue(18),
  symbol: vi.fn().mockResolvedValue('TOKEN'),
  name: vi.fn().mockResolvedValue('Test Token'),
  getAddress: vi.fn().mockResolvedValue('0xTokenAddress'),
};

// Mock RootChainManager contract
export const mockRootChainManagerContract = {
  depositEtherFor: vi.fn().mockResolvedValue(mockDepositEthTx),
  depositFor: vi.fn().mockResolvedValue(mockDepositTx),
  getAddress: vi.fn().mockResolvedValue('0xRootChainManagerAddress'),
};

// Mock Governor contract
export const mockGovernorContract = {
  getVotes: vi.fn().mockResolvedValue(BigInt(100)),
  proposalThreshold: vi.fn().mockResolvedValue(BigInt(1000)),
  votingDelay: vi.fn().mockResolvedValue(BigInt(6570)), // ~1 day in blocks
  votingPeriod: vi.fn().mockResolvedValue(BigInt(45818)), // ~1 week in blocks
  quorum: vi.fn().mockResolvedValue(BigInt(400000)),
  getAddress: vi.fn().mockResolvedValue('0xGovernorAddress'),
};

// Mock Token contract
export const mockTokenContract = {
  balanceOf: vi.fn().mockResolvedValue(BigInt(1000000000000000000n)),
  decimals: vi.fn().mockResolvedValue(18),
  symbol: vi.fn().mockResolvedValue('GOV'),
  name: vi.fn().mockResolvedValue('Governance Token'),
  getAddress: vi.fn().mockResolvedValue('0xTokenAddress'),
};

// Mock Timelock contract
export const mockTimelockContract = {
  getMinDelay: vi.fn().mockResolvedValue(BigInt(172800)), // 2 days in seconds
  getAddress: vi.fn().mockResolvedValue('0xTimelockAddress'),
};

// Mock contract creation function
export const createMockContract = vi.fn().mockImplementation((address, abi, signer) => {
  if (abi && abi.find((item: any) => item.name === 'approve')) {
    return mockERC20Contract;
  } else if (abi && abi.find((item: any) => item.name === 'depositFor')) {
    return mockRootChainManagerContract;
  } else if (abi && abi.find((item: any) => item.name === 'proposalThreshold')) {
    return mockGovernorContract;
  } else if (abi && abi.find((item: any) => item.name === 'getMinDelay')) {
    return mockTimelockContract;
  } else {
    return mockTokenContract;
  }
});

// Mock ethers
vi.mock('ethers', () => {
  return {
    Contract: vi.fn().mockImplementation((address, abi, signerOrProvider) => {
      return createMockContract(address, abi, signerOrProvider);
    }),
    JsonRpcProvider: vi.fn().mockImplementation(() => mockProvider()),
    Wallet: vi.fn().mockImplementation(() => mockWallet()),
  };
});

// Mock wallet
export const mockWallet = vi.fn().mockImplementation(() => ({
  address: '0xUserAddress',
  signMessage: vi.fn().mockResolvedValue('0xSignedMessage'),
  signTransaction: vi.fn().mockResolvedValue('0xSignedTransaction'),
  connect: vi.fn().mockReturnThis(),
}));

// Mock provider
export const mockProvider = vi.fn().mockImplementation(() => ({
  getBalance: vi.fn().mockResolvedValue(BigInt(1000000000000000000n)),
  getBlock: vi.fn().mockResolvedValue({
    hash: '0xBlockHash',
    number: 1000000,
    timestamp: Math.floor(Date.now() / 1000),
  }),
  getTransaction: vi.fn().mockResolvedValue({
    hash: '0xTransactionHash',
    from: '0xSenderAddress',
    to: '0xRecipientAddress',
    value: BigInt(1000000000000000000n),
  }),
  getTransactionReceipt: vi.fn().mockResolvedValue({
    status: 1,
    transactionHash: '0xTransactionHash',
    blockNumber: 1000000,
    gasUsed: BigInt(21000),
  }),
}));

// Helper functions to create mock instances
export const createMockWallet = () => mockWallet();
export const createMockProvider = () => mockProvider();

// Mock clients for viem
export const mockL1PublicClient = {
  getBlockNumber: vi.fn().mockResolvedValue(BigInt(1000000)),
  getBalance: vi.fn().mockResolvedValue(BigInt(1000000000000000000n)),
  getBlock: vi.fn().mockResolvedValue({
    hash: '0xBlockHash',
    number: BigInt(1000000),
    timestamp: BigInt(Math.floor(Date.now() / 1000)),
  }),
  getTransaction: vi.fn().mockResolvedValue({
    hash: '0xTransactionHash',
    from: '0xSenderAddress',
    to: '0xRecipientAddress',
    value: BigInt(1000000000000000000n),
  }),
  getTransactionReceipt: vi.fn().mockResolvedValue({
    status: 1,
    transactionHash: '0xTransactionHash',
    blockNumber: BigInt(1000000),
    gasUsed: BigInt(21000),
  }),
  readContract: vi.fn().mockImplementation(({ functionName }) => {
    switch (functionName) {
      case 'balanceOf':
        return BigInt(1000000000000000000n);
      case 'symbol':
        return 'TOKEN';
      case 'decimals':
        return 18;
      case 'name':
        return 'Test Token';
      default:
        return null;
    }
  }),
  call: vi.fn().mockResolvedValue({ data: '0x0000000000000000000000000000000000000000000000000000000000000000' }),
  estimateGas: vi.fn().mockResolvedValue(BigInt(21000)),
};

export const mockL2PublicClient = {
  ...mockL1PublicClient,
  // Override any L2-specific behavior here if needed
};

export const mockL1WalletClient = {
  account: { address: '0xUserAddress' },
  getAddresses: vi.fn().mockResolvedValue(['0xUserAddress']),
  sendTransaction: vi.fn().mockResolvedValue('0xTransactionHash'),
  writeContract: vi.fn().mockResolvedValue('0xContractTxHash'),
};

export const mockL2WalletClient = {
  ...mockL1WalletClient,
  // Override any L2-specific behavior here if needed
};

export const mockTestClient = {
  mine: vi.fn().mockResolvedValue({}),
  setBalance: vi.fn().mockResolvedValue({}),
  impersonateAccount: vi.fn().mockResolvedValue({}),
  stopImpersonatingAccount: vi.fn().mockResolvedValue({}),
};

// Mock polygon chains object
export const mockPolygonChains = {
  'ethereum': {
    id: 1,
    name: 'Ethereum',
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: ['https://mainnet.infura.io/v3/mock-key'],
      },
      custom: {
        http: [],
      },
    },
    blockExplorers: {
      default: {
        name: 'Etherscan',
        url: 'https://etherscan.io',
      },
    },
    testnet: false,
  },
  'polygon': {
    id: 137,
    name: 'Polygon',
    nativeCurrency: {
      name: 'MATIC',
      symbol: 'MATIC',
      decimals: 18,
    },
    rpcUrls: {
      default: {
        http: ['https://polygon-mainnet.infura.io/v3/mock-key'],
      },
      custom: {
        http: [],
      },
    },
    blockExplorers: {
      default: {
        name: 'PolygonScan',
        url: 'https://polygonscan.com',
      },
    },
    testnet: false,
  },
};

// Set up mock implementations for viem functions
vi.mocked(createPublicClient).mockImplementation(({ chain }) => {
  return chain?.id === 137 ? mockL2PublicClient : mockL1PublicClient;
});

vi.mocked(createWalletClient).mockImplementation(({ chain, account }) => {
  const client = chain?.id === 137 ? mockL2WalletClient : mockL1WalletClient;
  if (account) {
    client.account = account;
  }
  return client;
});

vi.mocked(createTestClient).mockReturnValue(mockTestClient);

// Mock for Gas Service
export const mockGasEstimates = {
  safeLow: {
    maxFeePerGas: BigInt(30000000000),
    maxPriorityFeePerGas: BigInt(1000000000),
  },
  average: {
    maxFeePerGas: BigInt(50000000000),
    maxPriorityFeePerGas: BigInt(1500000000),
  },
  fast: {
    maxFeePerGas: BigInt(80000000000),
    maxPriorityFeePerGas: BigInt(2000000000),
  },
  estimatedBaseFee: BigInt(29000000000),
}; 
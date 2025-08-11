import dotenv from 'dotenv';
import path from 'node:path';
import { vi } from 'vitest';

// Resolve the path to the root .env file
const workspaceRoot = path.resolve(__dirname, '../../');
const envPath = path.resolve(workspaceRoot, '.env');

console.log(`Vitest setup: Attempting to load .env from: ${envPath}`);
const result = dotenv.config({ path: envPath });

if (result.error) {
  console.warn(`Vitest setup: Warning - Error loading .env from ${envPath}:`, result.error.message);
} else {
  if (result.parsed && Object.keys(result.parsed).length > 0) {
    console.log(`Vitest setup: .env file loaded successfully from ${envPath}.`);
  } else if (!process.env.ALCHEMY_API_KEY && !process.env.ZKEVM_RPC_URL) {
    console.warn(
      `Vitest setup: .env file at ${envPath} might be empty or critical variables (ALCHEMY_API_KEY, ZKEVM_RPC_URL) not found after loading attempt.`
    );
  } else {
    console.log(
      `Vitest setup: .env file at ${envPath} was processed. Variables might have been already set or the file is empty.`
    );
  }
}

// --- @elizaos/core Mocks ---

// Mock logger for @elizaos/core
export const elizaOsLoggerMock = {
  log: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

// Mock runtime for @elizaos/core
export const mockRuntime = {
  getSetting: vi.fn().mockImplementation((key: string) => {
    const settings: Record<string, string | undefined> = {
      ALCHEMY_API_KEY: process.env.ALCHEMY_API_KEY || 'test-alchemy-key',
      ZKEVM_RPC_URL: process.env.ZKEVM_RPC_URL || 'https://zkevm-rpc.com',
      PRIVATE_KEY:
        process.env.PRIVATE_KEY ||
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    };
    return settings[key] || undefined;
  }),
  getService: vi.fn().mockReturnValue(null),
  registerAction: vi.fn(),
  registerService: vi.fn(),
  useModel: vi.fn().mockResolvedValue('{"result":"test"}'),
  getConfig: vi.fn().mockImplementation((key, defaultValue) => {
    const configs: Record<string, string | undefined> = {
      'zkevm.alchemyApiKey': process.env.ALCHEMY_API_KEY || 'test-alchemy-key',
      'zkevm.rpcUrl': process.env.ZKEVM_RPC_URL || 'https://zkevm-rpc.com',
      'zkevm.privateKey':
        process.env.PRIVATE_KEY ||
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    };
    return configs[key] || defaultValue;
  }),
  getCache: vi.fn().mockResolvedValue(undefined),
  setCache: vi.fn().mockResolvedValue(undefined),
  deleteCache: vi.fn().mockResolvedValue(undefined),
};

// Create the mock implementation for @elizaos/core
vi.mock('@elizaos/core', () => {
  return {
    logger: elizaOsLoggerMock,
    parseJSONObjectFromText: vi.fn((text) => {
      try {
        return JSON.parse(text);
      } catch (e) {
        throw new Error(`Failed to parse JSON during test: ${text}`);
      }
    }),
  };
});

// --- Ethers Mocks ---
export const mockEthersProvider = {
  getBlockNumber: vi.fn().mockResolvedValue(12345),
  getBalance: vi.fn().mockResolvedValue(BigInt('1000000000000000000')), // 1 ETH
  getTransaction: vi.fn().mockResolvedValue({
    hash: '0x1234567890abcdef',
    blockNumber: 12345,
    from: '0xfrom',
    to: '0xto',
    value: BigInt('1000000000000000000'),
    gasPrice: BigInt('20000000000'),
    gasLimit: BigInt('21000'),
  }),
  getTransactionReceipt: vi.fn().mockResolvedValue({
    transactionHash: '0x1234567890abcdef',
    blockNumber: 12345,
    status: 1,
    gasUsed: BigInt('21000'),
    logs: [],
  }),
  send: vi.fn().mockImplementation((method: string, params: any[]) => {
    if (method === 'eth_gasPrice') {
      return Promise.resolve('0x4a817c800'); // 20 gwei
    }
    if (method === 'eth_getLogs') {
      return Promise.resolve([]);
    }
    if (method === 'zkevm_getBatchByNumber') {
      return Promise.resolve({
        number: '0x3039',
        timestamp: '0x63ef666d',
        transactions: ['0x1111', '0x2222'],
        stateRoot: '0xabcd',
        globalExitRoot: '0x9876',
      });
    }
    return Promise.resolve(null);
  }),
  getTransactionCount: vi.fn().mockResolvedValue(42),
  getCode: vi.fn().mockResolvedValue('0x608060405234801561001057600080fd5b50'),
  getStorage: vi
    .fn()
    .mockResolvedValue('0x0000000000000000000000000000000000000000000000000000000000000001'),
  estimateGas: vi.fn().mockResolvedValue(BigInt('21000')),
};

vi.mock('ethers', () => ({
  JsonRpcProvider: vi.fn().mockImplementation(() => mockEthersProvider),
  Contract: vi.fn().mockImplementation(() => ({
    balanceOf: vi.fn().mockResolvedValue(BigInt('1000000000000000000')),
    symbol: vi.fn().mockResolvedValue('TOKEN'),
    name: vi.fn().mockResolvedValue('Test Token'),
    decimals: vi.fn().mockResolvedValue(18),
  })),
  formatUnits: vi.fn().mockReturnValue('1.0'),
  parseUnits: vi.fn().mockReturnValue(BigInt('1000000000000000000')),
}));

// Set up environment variables for tests
if (!process.env.ALCHEMY_API_KEY) {
  process.env.ALCHEMY_API_KEY = 'test-alchemy-key';
}
if (!process.env.ZKEVM_RPC_URL) {
  process.env.ZKEVM_RPC_URL = 'https://zkevm-rpc.com';
}

console.log('Vitest setup complete for Polygon zkEVM plugin');

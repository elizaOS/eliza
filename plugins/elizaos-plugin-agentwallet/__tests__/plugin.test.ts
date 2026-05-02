/**
 * elizaos-plugin-agentwallet — unit tests
 *
 * Uses Jest + manual mocks for agentwallet-sdk, viem, and viem/accounts.
 * Mocks the REAL SDK exports (createWallet, checkBudget, agentExecute,
 * SolanaWallet, JupiterSwapClient, UnifiedBridge, createX402Client, SwapModule).
 */

// ── Mock viem (imported dynamically in wallet.ts) ────────────────────────────
jest.mock('viem', () => ({
  createWalletClient: jest.fn().mockReturnValue({ account: { address: '0xMockWallet' } }),
  createPublicClient: jest.fn(),
  http: jest.fn(),
  encodeFunctionData: jest.fn().mockReturnValue('0xmockdata'),
  parseUnits: jest.fn().mockReturnValue(BigInt(100_000_000)),
  zeroAddress: '0x0000000000000000000000000000000000000000',
}));

jest.mock('viem/accounts', () => ({
  privateKeyToAccount: jest.fn().mockReturnValue({ address: '0xMockAccount' }),
}));

jest.mock('viem/chains', () => ({
  base: { id: 8453, name: 'Base' },
  baseSepolia: { id: 84532, name: 'Base Sepolia' },
  mainnet: { id: 1, name: 'Ethereum' },
  arbitrum: { id: 42161, name: 'Arbitrum' },
  optimism: { id: 10, name: 'Optimism' },
  polygon: { id: 137, name: 'Polygon' },
}));

// ── Mock the real agentwallet-sdk exports ─────────────────────────────────────
const mockEvmWallet = {
  address: '0xMockContractAddress',
  publicClient: {},
  walletClient: { account: { address: '0xMockWallet' } },
  chain: { id: 8453 },
};

const mockSolanaWalletInstance = {
  getPublicKey: jest.fn().mockReturnValue({ toBase58: () => 'MockSolanaAddress' }),
  getSolBalance: jest.fn().mockResolvedValue(BigInt(500_000_000)), // 0.5 SOL
  transfer: jest.fn().mockResolvedValue({ signature: 'mocksolsig123' }),
};

const mockX402ClientInstance = {
  fetch: jest.fn().mockResolvedValue({
    status: 200,
    headers: {
      get: (key: string) => {
        if (key === 'content-type') return 'application/json';
        if (key === 'x-payment-amount') return '0.001';
        return null;
      },
    },
  }),
};

const mockSwapModuleInstance = {
  swap: jest.fn().mockResolvedValue({ txHash: '0xmockswaptx', quote: { amountOut: BigInt(48_320_000) }, approvalRequired: false }),
};

const mockUnifiedBridgeInstance = {
  bridge: jest.fn().mockResolvedValue({
    burnTxHash: '0xmockbridge',
    mintTxHash: '0xmockbridgemint',
    amount: BigInt(100_000_000),
    platformFee: BigInt(100_000),
    fromChain: 'base',
    toChain: 'solana',
    recipient: '0xMockContractAddress',
    nonce: BigInt(1),
  }),
};

jest.mock('agentwallet-sdk', () => ({
  createWallet: jest.fn().mockReturnValue(mockEvmWallet),
  checkBudget: jest.fn().mockResolvedValue({
    token: '0x0000000000000000000000000000000000000000',
    perTxLimit: BigInt(1_000_000_000_000_000_000),
    remainingInPeriod: BigInt(500_000_000_000_000_000), // 0.5 ETH in wei
  }),
  agentExecute: jest.fn().mockResolvedValue({ executed: true, txHash: '0xmocktx' }),
  NATIVE_TOKEN: '0x0000000000000000000000000000000000000000',
  SolanaWallet: jest.fn().mockImplementation(() => mockSolanaWalletInstance),
  JupiterSwapClient: jest.fn().mockImplementation(() => ({
    swap: jest.fn().mockResolvedValue({ signature: 'mockjupsig', outAmount: BigInt(48_320_000) }),
  })),
  SwapModule: jest.fn().mockImplementation(() => mockSwapModuleInstance),
  UnifiedBridge: jest.fn().mockImplementation(() => mockUnifiedBridgeInstance),
  createX402Client: jest.fn().mockReturnValue(mockX402ClientInstance),
  createBridge: jest.fn(),
}));

import agentWalletPlugin, {
  balanceAction,
  transferAction,
  swapAction,
  bridgeAction,
  x402PayAction,
  walletProvider,
} from '../src/index';

// ── Mock runtime ─────────────────────────────────────────────────────────────
const mockRuntime = {
  getSetting: (key: string) => {
    const settings: Record<string, string> = {
      AGENTWALLET_PRIVATE_KEY: '0xdeadbeef',
      AGENTWALLET_ACCOUNT_ADDRESS: '0xMockContractAddress',
      AGENTWALLET_CHAIN: 'base',
    };
    return settings[key] ?? null;
  },
} as any;

const mockRuntimeNoKey = {
  getSetting: () => null,
} as any;

const mockMessage = (text: string) =>
  ({
    content: { text },
    userId: 'test-user',
    roomId: 'test-room',
    agentId: 'test-agent',
  }) as any;

// ── Plugin structure tests ────────────────────────────────────────────────────
describe('Plugin structure', () => {
  it('exports default plugin object', () => {
    expect(agentWalletPlugin).toBeDefined();
    expect(agentWalletPlugin.name).toBe('agentwallet');
    expect(agentWalletPlugin.actions).toHaveLength(5);
    expect(agentWalletPlugin.providers).toHaveLength(1);
  });

  it('exports all actions individually', () => {
    expect(balanceAction.name).toBe('WALLET_BALANCE');
    expect(transferAction.name).toBe('WALLET_TRANSFER');
    expect(swapAction.name).toBe('WALLET_SWAP');
    expect(bridgeAction.name).toBe('WALLET_BRIDGE');
    expect(x402PayAction.name).toBe('X402_PAY');
  });

  it('exports walletProvider', () => {
    expect(walletProvider).toBeDefined();
    expect(typeof walletProvider.get).toBe('function');
  });
});

// ── Validation tests ──────────────────────────────────────────────────────────
describe('Action validation', () => {
  it('balanceAction validates true when private key is set', async () => {
    expect(await balanceAction.validate(mockRuntime, mockMessage('check balance'))).toBe(true);
  });

  it('balanceAction validates false when no private key', async () => {
    expect(await balanceAction.validate(mockRuntimeNoKey, mockMessage('check balance'))).toBe(false);
  });

  it('all actions validate false without private key', async () => {
    const actions = [balanceAction, transferAction, swapAction, bridgeAction, x402PayAction];
    for (const action of actions) {
      expect(await action.validate(mockRuntimeNoKey, mockMessage('test'))).toBe(false);
    }
  });
});

// ── Handler tests ─────────────────────────────────────────────────────────────
describe('Action handlers', () => {
  it('balanceAction returns balances', async () => {
    const callback = jest.fn();
    await balanceAction.handler(mockRuntime, mockMessage('what is my balance'), undefined, {}, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('ETH') })
    );
  });

  it('transferAction parses and executes send', async () => {
    const callback = jest.fn();
    await transferAction.handler(
      mockRuntime,
      mockMessage('send 50 USDC to 0xRecipientAddress'),
      undefined,
      {},
      callback
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('0xmocktx') })
    );
  });

  it('transferAction rejects unparseable intent', async () => {
    const callback = jest.fn();
    await transferAction.handler(mockRuntime, mockMessage('do something'), undefined, {}, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Could not parse') })
    );
  });

  it('swapAction executes swap', async () => {
    const callback = jest.fn();
    await swapAction.handler(mockRuntime, mockMessage('swap 0.5 USDC to ETH'), undefined, {}, callback);
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Swapped') })
    );
  });

  it('bridgeAction executes bridge', async () => {
    const callback = jest.fn();
    await bridgeAction.handler(
      mockRuntime,
      mockMessage('bridge 100 USDC from base to solana'),
      undefined,
      {},
      callback
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('0xmockbridge') })
    );
  });

  it('x402PayAction executes payment', async () => {
    const callback = jest.fn();
    await x402PayAction.handler(
      mockRuntime,
      mockMessage('pay x402 endpoint https://api.example.com/data max 0.001'),
      undefined,
      {},
      callback
    );
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('0.001') })
    );
  });
});

// ── Provider tests ────────────────────────────────────────────────────────────
describe('Wallet provider', () => {
  it('returns wallet state as formatted string', async () => {
    const result = await walletProvider.get(mockRuntime, mockMessage(''), undefined);
    expect(result).toContain('0xMockContractAddress');
    expect(result).toContain('ETH');
  });

  it('returns config error when no private key', async () => {
    const result = await walletProvider.get(mockRuntimeNoKey, mockMessage(''), undefined);
    expect(result).toContain('not configured');
  });
});

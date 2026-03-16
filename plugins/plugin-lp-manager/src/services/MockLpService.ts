import { IAgentRuntime, Service } from '@elizaos/core';
import type {
  ILpService,
  PoolInfo,
  AddLiquidityConfig,
  RemoveLiquidityConfig,
  TransactionResult,
  LpPositionDetails,
} from '../types.ts';

/**
 * Mock LP Service for testing that simulates real DEX behavior
 */
export class MockLpService extends Service implements ILpService {
  public readonly capabilityDescription = 'Provides standardized access to DEX liquidity pools.';
  
  private dexName: string;
  private mockPools: PoolInfo[] = [];
  private userPositions: Map<string, LpPositionDetails[]> = new Map();
  
  // Dynamic service type based on DEX name
  get serviceType(): string {
    return `mock-lp-${this.dexName}`;
  }

  constructor(runtime: IAgentRuntime, dexName: string = 'mock-dex') {
    super(runtime);
    this.dexName = dexName;
    this.initializeMockPools();
  }

  private initializeMockPools() {
    // Real token addresses on Solana mainnet
    const TOKEN_ADDRESSES = {
      SOL: 'So11111111111111111111111111111111111111112',
      USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      AI16Z: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC',
      DEGENAI: 'Gu3LDkn7VuCUNWpwxHpCpbNq7zWcHrZsQ8o8TDk1GDwT',
    };

    this.mockPools = [
      {
        id: `${this.dexName}-sol-usdc-1`,
        displayName: `SOL/USDC ${this.dexName} Pool`,
        dex: this.dexName,
        tokenA: {
          mint: TOKEN_ADDRESSES.SOL,
          symbol: 'SOL',
          reserve: '1000000000000',
          decimals: 9
        },
        tokenB: {
          mint: TOKEN_ADDRESSES.USDC,
          symbol: 'USDC',
          reserve: '50000000000000',
          decimals: 6
        },
        apr: 12.5,
        tvl: 50000000,
        fee: 0.003,
      },
      {
        id: `${this.dexName}-ai16z-sol-1`,
        displayName: `AI16Z/SOL ${this.dexName} Pool`,
        dex: this.dexName,
        tokenA: {
          mint: TOKEN_ADDRESSES.AI16Z,
          symbol: 'AI16Z',
          reserve: '500000000000',
          decimals: 9
        },
        tokenB: {
          mint: TOKEN_ADDRESSES.SOL,
          symbol: 'SOL',
          reserve: '100000000000',
          decimals: 9
        },
        apr: 18.7,
        tvl: 25000000,
        fee: 0.003,
      },
      {
        id: `${this.dexName}-degenai-sol-1`,
        displayName: `DEGENAI/SOL ${this.dexName} Pool`,
        dex: this.dexName,
        tokenA: {
          mint: TOKEN_ADDRESSES.DEGENAI,
          symbol: 'DEGENAI',
          reserve: '800000000000',
          decimals: 9
        },
        tokenB: {
          mint: TOKEN_ADDRESSES.SOL,
          symbol: 'SOL',
          reserve: '200000000000',
          decimals: 9
        },
        apr: 15.3,
        tvl: 30000000,
        fee: 0.003,
      },
    ];
  }

  getDexName(): string {
    return this.dexName;
  }

  async getPools(tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]> {
    console.log(`MockLpService.getPools called for ${this.dexName} with tokenA: ${tokenAMint}, tokenB: ${tokenBMint}`);
    
    if (!tokenAMint && !tokenBMint) {
      return this.mockPools;
    }

    return this.mockPools.filter(pool => {
      const hasTokenA = !tokenAMint || 
        pool.tokenA.mint === tokenAMint || 
        pool.tokenB.mint === tokenAMint;
      const hasTokenB = !tokenBMint || 
        pool.tokenA.mint === tokenBMint || 
        pool.tokenB.mint === tokenBMint;
      return hasTokenA && hasTokenB;
    });
  }

  async addLiquidity(config: AddLiquidityConfig): Promise<TransactionResult> {
    console.log(`MockLpService.addLiquidity called for ${this.dexName}`, config);
    
    // Simulate successful transaction
    const mockTxId = `mock-tx-${Date.now()}`;
    
    // Create a mock position
    const mockPosition: LpPositionDetails = {
      poolId: config.poolId,
      dex: this.dexName,
      valueUsd: parseFloat(config.tokenAAmountLamports) / 1e9 * 100, // Mock value
      lpTokenBalance: {
        address: `LP-${config.poolId}`,
        symbol: 'LP-TOKEN',
        name: 'Mock LP Token',
        balance: '1000000',
        decimals: 6,
        uiAmount: 1.0
      },
      underlyingTokens: [],
      metadata: {
        apr: 12.5,
        fee: 0.003
      }
    };

    // Store the position
    const userKey = config.userVault.publicKey.toBase58();
    const positions = this.userPositions.get(userKey) || [];
    positions.push(mockPosition);
    this.userPositions.set(userKey, positions);
    
    return {
      transactionId: mockTxId,
      success: true,
      data: {
        poolId: config.poolId,
        lpTokens: '1000000',
      }
    };
  }

  async removeLiquidity(config: RemoveLiquidityConfig): Promise<TransactionResult> {
    console.log(`MockLpService.removeLiquidity called for ${this.dexName}`, config);
    
    const mockTxId = `mock-tx-${Date.now()}`;
    
    // Remove position from storage
    const userKey = config.userVault.publicKey.toBase58();
    const positions = this.userPositions.get(userKey) || [];
    const updatedPositions = positions.filter(p => p.poolId !== config.poolId);
    this.userPositions.set(userKey, updatedPositions);
    
    return {
      transactionId: mockTxId,
      success: true,
      data: {
        poolId: config.poolId,
        tokenAReturned: '100000000', // Mock amounts
        tokenBReturned: '50000000',
      }
    };
  }

  async getLpPositionDetails(
    userPublicKey: string,
    poolIdOrPositionIdentifier: string
  ): Promise<LpPositionDetails | null> {
    console.log(`MockLpService.getLpPositionDetails called for ${this.dexName}`, userPublicKey, poolIdOrPositionIdentifier);
    
    const positions = this.userPositions.get(userPublicKey) || [];
    return positions.find(p => p.poolId === poolIdOrPositionIdentifier) || null;
  }

  async getMarketDataForPools(poolIds: string[]): Promise<Record<string, Partial<PoolInfo>>> {
    console.log(`MockLpService.getMarketDataForPools called for ${this.dexName}`, poolIds);
    
    const result: Record<string, Partial<PoolInfo>> = {};
    
    for (const poolId of poolIds) {
      const pool = this.mockPools.find(p => p.id === poolId);
      if (pool) {
        result[poolId] = {
          apr: pool.apr,
          tvl: pool.tvl,
          fee: pool.fee,
        };
      }
    }
    
    return result;
  }

  // Service lifecycle methods
  async start(): Promise<void> {
    console.info(`MockLpService for ${this.dexName} started`);
  }

  async stop(): Promise<void> {
    console.info(`MockLpService for ${this.dexName} stopped`);
  }

  // Static factory method for easier instantiation
  static create(runtime: IAgentRuntime, dexName: string = 'mock-dex'): MockLpService {
    return new MockLpService(runtime, dexName);
  }
}

/**
 * Register mock DEX services for testing
 */
export async function registerMockDexServices(runtime: IAgentRuntime): Promise<void> {
  const mockDexes = ['raydium', 'orca', 'meteora'];
  
  // Wait for DexInteractionService to be available
  setTimeout(async () => {
    for (const dexName of mockDexes) {
      const mockService = MockLpService.create(runtime, dexName);
      
      // Start the service
      await mockService.start();
      
      // Register with DexInteractionService directly
      const dexInteractionService = runtime.getService<any>('dex-interaction');
      if (dexInteractionService && dexInteractionService.registerDexService) {
        dexInteractionService.registerDexService(mockService);
        console.info(`Registered MockLpService for ${dexName}`);
      } else {
        console.warn('DexInteractionService not available for registering mock services');
      }
    }
    
    // Force rediscovery of services
    const dexInteractionService = runtime.getService<any>('dex-interaction');
    if (dexInteractionService && dexInteractionService.rediscoverServices) {
      dexInteractionService.rediscoverServices();
    }
  }, 1500); // Give time for other services to start
} 
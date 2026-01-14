/// <reference types="vitest/globals" />
import { IAgentRuntime } from '@elizaos/core';
import { Keypair as SolanaKeypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, Mock, vi } from 'vitest';
import { ILpService, LpPositionDetails, PoolInfo, TokenBalance, TransactionResult, UserLpProfile } from '../../types.ts';
import { DexInteractionService } from '../DexInteractionService.ts';

// Mocks
const mockVaultService = {
    createVault: vi.fn(),
    getVaultKeypair: vi.fn(),
    getVaultPublicKey: vi.fn(),
    getBalances: vi.fn(),
    exportPrivateKey: vi.fn(),
} as any;

const mockUserLpProfileService = {
  getProfile: vi.fn(),
  ensureProfile: vi.fn(),
  updateProfile: vi.fn(),
  getAllProfilesWithAutoRebalanceEnabled: vi.fn(),
  addTrackedPosition: vi.fn(),
  removeTrackedPosition: vi.fn(),
  getTrackedPositions: vi.fn(),
} as any;

function createMockDexLpService(name: string): ILpService {
    return {
        getDexName: vi.fn(() => name),
        getPools: vi.fn().mockResolvedValue([]),
        addLiquidity: vi.fn().mockResolvedValue({ success: true, transactionId: 'txAddDummy' } as TransactionResult & { lpTokensReceived?: TokenBalance }),
        removeLiquidity: vi.fn().mockResolvedValue({ success: true, transactionId: 'txRemoveDummy' } as TransactionResult & { tokensReceived?: TokenBalance[] }),
        getLpPositionDetails: vi.fn().mockResolvedValue(null),
        getMarketDataForPools: vi.fn().mockResolvedValue({}),
    } as unknown as ILpService;
}

const mockRuntime = {
    getService: vi.fn(),
    services: new Map()
} as any;

describe('DexInteractionService', () => {
  let dexInteractionService: DexInteractionService;
  let mockOrcaService: ILpService;
  let mockRaydiumService: ILpService;
  const testUserId = 'testUserForDex';
  const testUserKeypair = SolanaKeypair.generate();
  const testUserProfile: UserLpProfile = {
    userId: testUserId,
    vaultPublicKey: testUserKeypair.publicKey.toBase58(),
    encryptedSecretKey: 'dummyEncryptedKey',
    autoRebalanceConfig: { enabled: false, minGainThresholdPercent: 1, maxSlippageBps: 50 },
    version: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    
    (mockRuntime.getService as Mock)
      .mockReturnValueOnce(mockVaultService)
      .mockReturnValueOnce(mockUserLpProfileService);
      
    dexInteractionService = new DexInteractionService(mockRuntime);
    await dexInteractionService.start(mockRuntime);

    mockOrcaService = createMockDexLpService('orca');
    mockRaydiumService = createMockDexLpService('raydium');
    
    (mockUserLpProfileService.getProfile as Mock).mockResolvedValue(testUserProfile);
  });

  afterEach(async () => {
    await dexInteractionService.stop();
  });

  describe('DEX Service Registration', () => {
    it('should register a DEX service', async () => {
      dexInteractionService.registerDexService(mockOrcaService);
      await dexInteractionService.getPools('orca');
      expect(mockOrcaService.getPools).toHaveBeenCalled();
      // getDexName is called during registration and during getPools, so it's called at least once
      expect(mockOrcaService.getDexName).toHaveBeenCalled();
    });

    it('should overwrite an existing service if registered with the same name (case-insensitive)', async () => {
      // Register original service
      dexInteractionService.registerDexService(mockOrcaService);
      
      // Create a replacement service that returns different data
      const replacementOrcaService = createMockDexLpService('ORCA');
      const uniquePoolData = [{ id: 'replacement-pool' }];
      (replacementOrcaService.getPools as Mock).mockResolvedValue(uniquePoolData);
      
      // Register replacement service (should overwrite)
      dexInteractionService.registerDexService(replacementOrcaService);
      
      // Verify the replacement service is used
      const pools = await dexInteractionService.getPools('orca');
      expect(pools).toEqual(uniquePoolData);
      expect(replacementOrcaService.getPools).toHaveBeenCalled();
    });

    it('should throw if trying to get an unregistered DEX service', () => {
      expect(() => (dexInteractionService as any).getDexService('nonexistent')).toThrow(/No service registered/);
    });
  });

  describe('getPools', () => {
    beforeEach(() => {
        dexInteractionService.registerDexService(mockOrcaService);
        dexInteractionService.registerDexService(mockRaydiumService);
    });
    it('should get pools from a specific DEX', async () => {
      const orcaPools: PoolInfo[] = [{ id: 'orca1', dex: 'orca' } as PoolInfo];
      (mockOrcaService.getPools as Mock).mockResolvedValue(orcaPools);
      const pools = await dexInteractionService.getPools('orca');
      expect(pools).toEqual(orcaPools);
      expect(mockOrcaService.getPools).toHaveBeenCalled();
      expect(mockRaydiumService.getPools).not.toHaveBeenCalled();
    });

    it('should get pools from all registered DEXs if no dexName specified', async () => {
      const orcaPools: PoolInfo[] = [{ id: 'orca1', dex: 'orca' } as PoolInfo];
      const raydiumPools: PoolInfo[] = [{ id: 'raydium1', dex: 'raydium' } as PoolInfo];
      (mockOrcaService.getPools as Mock).mockResolvedValue(orcaPools);
      (mockRaydiumService.getPools as Mock).mockResolvedValue(raydiumPools);
      const pools = await dexInteractionService.getPools();
      expect(pools).toEqual([...orcaPools, ...raydiumPools]);
      expect(mockOrcaService.getPools).toHaveBeenCalled();
      expect(mockRaydiumService.getPools).toHaveBeenCalled();
    });
  });

  describe('addLiquidity', () => {
    const addParams = { userVault: testUserKeypair, poolId: 'p1', tokenAAmountLamports: '1000', tokenBAmountLamports: '2000', dexName: 'orca', slippageBps: 50, tickLowerIndex: 100, tickUpperIndex: 200 };
    const expectedLpTokens: TokenBalance = { address: 'lpOrca', balance: '10', decimals: 6, symbol: 'ORCA-LP' };
    const expectedResult: TransactionResult & { lpTokensReceived?: TokenBalance } = { 
        success: true, 
        transactionId: 'txAddOrca', 
        lpTokensReceived: expectedLpTokens 
    };

    it('should add liquidity via the correct DEX service', async () => {
      dexInteractionService.registerDexService(mockOrcaService);
      (mockOrcaService.addLiquidity as Mock).mockResolvedValue(expectedResult);

      const result = await dexInteractionService.addLiquidity(addParams);
      
      expect(result).toEqual(expectedResult);
      expect(mockOrcaService.addLiquidity).toHaveBeenCalledWith(expect.objectContaining({
          userVault: testUserKeypair,
          poolId: 'p1',
          tokenAAmountLamports: '1000',
          tokenBAmountLamports: '2000',
          slippageBps: 50,
          tickLowerIndex: 100,
          tickUpperIndex: 200
      }));
      expect(mockUserLpProfileService.getProfile).not.toHaveBeenCalled();
      expect(mockVaultService.getVaultKeypair).not.toHaveBeenCalled();
    });

    it('should throw if DEX service not found for addLiquidity', async () => {
        await expect(dexInteractionService.addLiquidity({ ...addParams, dexName: 'unknown' }))
            .rejects.toThrow(/No service registered for DEX 'unknown'/);
    });
  });
  
  describe('removeLiquidity', () => {
    const removeParams = { userVault: testUserKeypair, lpTokenAmountLamports: '500', poolId: 'pRay', dexName: 'raydium', slippageBps: 30 };
    const expectedTokens: TokenBalance[] = [{address: 'SOL', balance:'100', decimals:9}];
    const expectedResult: TransactionResult & { tokensReceived?: TokenBalance[] } = { 
        success: true, 
        transactionId: 'txRemoveRaydium', 
        tokensReceived: expectedTokens 
    };

    it('should remove liquidity via the correct DEX service', async () => {
      dexInteractionService.registerDexService(mockRaydiumService);
      (mockRaydiumService.removeLiquidity as Mock).mockResolvedValue(expectedResult);

      const result = await dexInteractionService.removeLiquidity(removeParams);

      expect(result).toEqual(expectedResult);
      expect(mockRaydiumService.removeLiquidity).toHaveBeenCalledWith(expect.objectContaining({
        userVault: testUserKeypair,
        poolId: 'pRay',
        lpTokenAmountLamports: '500',
        slippageBps: 30
      }));
      expect(mockUserLpProfileService.getProfile).not.toHaveBeenCalled();
      expect(mockVaultService.getVaultKeypair).not.toHaveBeenCalled();
    });

    it('should throw if DEX service not found for removeLiquidity', async () => {
        await expect(dexInteractionService.removeLiquidity({ ...removeParams, dexName: 'unknown' }))
            .rejects.toThrow(/No service registered for DEX 'unknown'/);
    });
  });

  describe('getLpPosition', () => {
    beforeEach(() => dexInteractionService.registerDexService(mockOrcaService));

    it('should get LP position from the correct DEX service', async () => {
      const poolId = 'orcaPoolPos';
      const expectedPosition = { poolId, dex: 'orca', valueUsd: 100 } as LpPositionDetails;
      (mockOrcaService.getLpPositionDetails as Mock).mockResolvedValue(expectedPosition);

      const position = await dexInteractionService.getLpPosition(testUserId, poolId, 'orca');

      expect(position).toEqual(expectedPosition);
      expect(mockUserLpProfileService.getProfile).toHaveBeenCalledWith(testUserId);
      expect(mockOrcaService.getLpPositionDetails).toHaveBeenCalledWith(testUserKeypair.publicKey.toBase58(), poolId);
    });

    it('should throw if user profile not found for getLpPosition', async () => {
      (mockUserLpProfileService.getProfile as Mock).mockResolvedValue(null);
      await expect(dexInteractionService.getLpPosition(testUserId, 'p1', 'orca')).rejects.toThrow(/User profile or vault public key not found/);
    });
  });

  describe('getAllUserLpPositions', () => {
    it('should attempt to fetch positions (stubbed functionality)', async () => {
        dexInteractionService.registerDexService(mockOrcaService);
        
        // Mock getTrackedPositions to return empty array
        (mockUserLpProfileService.getTrackedPositions as Mock).mockResolvedValue([]);
        
        await expect(dexInteractionService.getAllUserLpPositions(testUserId)).resolves.toEqual([]);
        expect(mockUserLpProfileService.getProfile).toHaveBeenCalledWith(testUserId);
    });

    it('should return empty array if profile or public key not found', async () => {
        (mockUserLpProfileService.getProfile as Mock).mockResolvedValue(null);
        const positions = await dexInteractionService.getAllUserLpPositions(testUserId);
        expect(positions).toEqual([]);
    });
  });

  describe('discover and register LP services on start', () => {
    let service: DexInteractionService;
    let runtime: IAgentRuntime;
    let dummyLpService: ILpService;

    beforeEach(() => {
        dummyLpService = {
            getDexName: () => 'dummy',
            getPools: vi.fn(),
            addLiquidity: vi.fn(),
            removeLiquidity: vi.fn(),
            getLpPositionDetails: vi.fn(),
            getMarketDataForPools: vi.fn(),
            capabilityDescription: 'Dummy LP service',
            runtime: {} as any,
            start: vi.fn(),
            stop: vi.fn(),
        } as any;

        runtime = {
            getService: vi.fn()
              .mockReturnValueOnce(mockVaultService)
              .mockReturnValueOnce(mockUserLpProfileService),
            services: new Map([
                ['dummyLpService', dummyLpService]
            ])
        } as any;

        service = new DexInteractionService(runtime);
    });

    it('should discover and register LP services on start', async () => {
        await service.start(runtime);
        const pools = await service.getPools('dummy');
        expect(dummyLpService.getPools).toHaveBeenCalled();
    });
  });

}); 
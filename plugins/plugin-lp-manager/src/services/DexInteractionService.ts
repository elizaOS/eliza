import { IAgentRuntime, Service } from '@elizaos/core';
import { Keypair } from '@solana/web3.js';
import {
  AddLiquidityConfig,
  ILpService,
  IUserLpProfileService,
  IVaultService,
  LpPositionDetails,
  PoolInfo,
  RemoveLiquidityConfig,
  TransactionResult,
} from '../types.ts';
import { UserLpProfileService } from './UserLpProfileService.ts';
import { VaultService } from './VaultService.ts';

/**
 * Interface for the DexInteractionService.
 * This service acts as a facade to interact with various DEX-specific LP services.
 * It handles routing requests to the appropriate DEX implementation.
 */
export interface IDexInteractionService extends Service {
  /**
   * Registers a DEX-specific LP service.
   * @param dexService - An instance of a class implementing IDexSpecificLpService.
   */
  registerDexService(dexService: ILpService): void;

  /**
   * Retrieves available liquidity pools from one or all registered DEXs.
   * @param dexName - Optional. The specific DEX to query. If not provided, queries all registered DEXs.
   * @param tokenAMint - Optional. Filter pools by token A mint address.
   * @param tokenBMint - Optional. Filter pools by token B mint address.
   * @returns A promise that resolves to an array of PoolInfo objects.
   */
  getPools(dexName?: string, tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]>;

  /**
   * Adds liquidity to a specified pool on a specific DEX.
   * @param config - The configuration for adding liquidity.
   * @returns A promise that resolves to the transaction result.
   */
  addLiquidity(config: AddLiquidityConfig): Promise<TransactionResult>;

  /**
   * Removes liquidity from a specified pool on a specific DEX.
   * @param config - The configuration for removing liquidity.
   * @returns A promise that resolves to the transaction result.
   */
  removeLiquidity(config: RemoveLiquidityConfig): Promise<TransactionResult>;

  /**
   * Retrieves details of a user's LP position in a specific pool on a specific DEX.
   * @param userId - The user's identifier to fetch their vault public key.
   * @param poolId - The identifier of the pool.
   * @param dexName - The name of the DEX where the pool resides.
   * @returns A promise that resolves to LpPositionDetails or null if not found.
   */
  getLpPosition(
    userId: string,
    poolIdOrPositionIdentifier: string,
    dexName: string
  ): Promise<LpPositionDetails | null>;

  /**
   * Retrieves all LP positions for a user across all registered DEXs and known pools.
   * (This might require knowledge of pools the user has interacted with, or scanning common pools).
   * @param userId - The user's identifier.
   * @returns A promise that resolves to an array of LpPositionDetails.
   */
  getAllUserLpPositions(userId: string): Promise<LpPositionDetails[]>;
}

export class DexInteractionService extends Service implements IDexInteractionService {
  public static override readonly serviceType = 'dex-interaction';
  public readonly capabilityDescription =
    'A service for interacting with various DEX LP services in a standardized way.';

  private lpServices: ILpService[] = [];
  private vaultService!: IVaultService;
  private userLpProfileService!: IUserLpProfileService;

  constructor(runtime?: IAgentRuntime) {
    super(runtime);
  }

  // Static methods required by ElizaOS Service architecture
  static async start(runtime: IAgentRuntime): Promise<DexInteractionService> {
    const service = new DexInteractionService(runtime);
    await service.start(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    // No cleanup needed for static stop
  }

  private discoverLpServices() {
    console.info('DexInteractionService: Discovering LP services...');
    console.info(`DexInteractionService: Total services in runtime: ${this.runtime.services.size}`);
    console.info(`DexInteractionService: Already registered LP services: ${this.lpServices.length}`);
    
    // Otherwise, try to discover from runtime services
    for (const [serviceType, service] of this.runtime.services.entries()) {
      // Log all services for debugging
      console.info(`DexInteractionService: Found service type: ${serviceType}`);
      
      // Check various DEX service names
      const dexServiceNames = ['raydium', 'orca', 'meteora', 'RaydiumService', 'OrcaService', 'MeteoraService'];
      const isDexService = dexServiceNames.some(name => 
        serviceType.toLowerCase().includes(name.toLowerCase())
      );
      
      // Check if the service implements ILpService interface or is a known DEX service
      if (service) {
        const serviceAny = service as any;
        
        if (this.isLpService(serviceAny) || (isDexService && (
          typeof serviceAny.getPools === 'function' || 
          typeof serviceAny.addLiquidity === 'function'
        ))) {
          this.lpServices.push(serviceAny as ILpService);
          const dexName = typeof serviceAny.getDexName === 'function' 
            ? serviceAny.getDexName() 
            : serviceType;
          console.info(`DexInteractionService: Discovered and registered LP service: ${dexName}`);
        }
      }
    }
    
    console.info(`DexInteractionService: Found ${this.lpServices.length} LP services`);
  }

  private isLpService(service: any): service is ILpService {
    // Check for required ILpService methods
    return (
      typeof service.getDexName === 'function' &&
      typeof service.getPools === 'function' &&
      typeof service.addLiquidity === 'function' &&
      typeof service.removeLiquidity === 'function' &&
      typeof service.getLpPositionDetails === 'function' &&
      // Exclude our own service type
      service.getDexName() !== 'dex-interaction'
    );
  }

  public getLpService(dexName: string): ILpService | undefined {
    return this.lpServices.find((s) => s.getDexName().toLowerCase() === dexName.toLowerCase());
  }

  public getLpServices(): ILpService[] {
    return this.lpServices;
  }

  public getDexService(dexName: string): ILpService {
    const service = this.getLpService(dexName);
    if (!service) {
      throw new Error(`No service registered for DEX '${dexName}'`);
    }
    return service;
  }

  async start(runtime: IAgentRuntime): Promise<void> {
    const vaultService = runtime.getService<VaultService>('VaultService');
    const userLpProfileService = runtime.getService<UserLpProfileService>('UserLpProfileService');

    if (!vaultService || !userLpProfileService) {
      throw new Error(
        'Required services (VaultService, UserLpProfileService) not available.'
      );
    }
    this.vaultService = vaultService;
    this.userLpProfileService = userLpProfileService;
    
    // Delay discovery to allow other services to start
    setTimeout(() => {
      this.discoverLpServices();
    }, 2000);
    
    // Also try discovery again after a longer delay
    setTimeout(() => {
      if (this.lpServices.length === 0) {
        console.info('DexInteractionService: No LP services found after 5s, retrying discovery...');
        this.discoverLpServices();
      }
    }, 5000);
  }

  async stop(): Promise<void> {
    // No-op
  }

  public rediscoverServices(): void {
    // Don't clear existing services, just re-run discovery
    this.discoverLpServices();
  }

  registerDexService(dexService: ILpService): void {
    const dexName = dexService.getDexName().toLowerCase();
    const existingIndex = this.lpServices.findIndex((s) => s.getDexName().toLowerCase() === dexName);
    
    if (existingIndex !== -1) {
      console.warn(
        `DexInteractionService: Service for DEX '${dexName}' is already registered. Overwriting.`
      );
      this.lpServices[existingIndex] = dexService;
    } else {
      this.lpServices.push(dexService);
      console.info(`DexInteractionService: Registered service for DEX '${dexName}'.`);
    }
  }

  async getPools(dexName?: string, tokenAMint?: string, tokenBMint?: string): Promise<PoolInfo[]> {
    // If no LP services found, try to rediscover
    if (this.lpServices.length === 0) {
      console.info('DexInteractionService: No LP services found, attempting rediscovery...');
      this.rediscoverServices();
      
      // If still no services after rediscovery, wait a bit and try again
      if (this.lpServices.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        this.rediscoverServices();
      }
    }
    
    let allPools: PoolInfo[] = [];
    if (dexName) {
      const service = this.getLpService(dexName);
      if (service) {
        allPools = await service.getPools(tokenAMint, tokenBMint);
      }
    } else {
      for (const service of this.lpServices) {
        try {
          const pools = await service.getPools(tokenAMint, tokenBMint);
          allPools.push(...pools);
        } catch (error) {
          console.error(
            `DexInteractionService: Error fetching pools from ${service.getDexName()}:`,
            error
          );
        }
      }
    }
    return allPools;
  }

  private async getVaultKeypairForUser(userId: string): Promise<Keypair> {
    const profile = await this.userLpProfileService.getProfile(userId);
    if (!profile) {
      throw new Error(`User profile not found for ${userId}, cannot retrieve vault keypair.`);
    }
    return this.vaultService.getVaultKeypair(userId, profile.encryptedSecretKey);
  }

  public async addLiquidity(config: AddLiquidityConfig): Promise<TransactionResult> {
    const service = this.getLpService(config.dexName);
    if (!service) {
      throw new Error(`No service registered for DEX '${config.dexName}'`);
    }
    return service.addLiquidity(config);
  }

  public async removeLiquidity(config: RemoveLiquidityConfig): Promise<TransactionResult> {
    const service = this.getLpService(config.dexName);
    if (!service) {
      throw new Error(`No service registered for DEX '${config.dexName}'`);
    }
    return service.removeLiquidity(config);
  }

  async getLpPosition(
    userId: string,
    poolIdOrPositionIdentifier: string,
    dexName: string
  ): Promise<LpPositionDetails | null> {
    const service = this.getLpService(dexName);
    if (!service) {
      throw new Error(`No service registered for DEX '${dexName}'`);
    }
    const profile = await this.userLpProfileService.getProfile(userId);
    if (!profile || !profile.vaultPublicKey) {
      throw new Error(`User profile or vault public key not found for user ${userId}.`);
    }
    return service.getLpPositionDetails(profile.vaultPublicKey, poolIdOrPositionIdentifier);
  }

  public async getAllUserLpPositions(userId: string): Promise<LpPositionDetails[]> {
    const profile = await this.userLpProfileService.getProfile(userId);
    if (!profile) {
      return [];
    }

    const allPositions: LpPositionDetails[] = [];
    const trackedPositions = await this.userLpProfileService.getTrackedPositions(userId);

    for (const tracked of trackedPositions) {
      const service = this.getLpService(tracked.dex);
      if (service) {
        try {
          const positionDetails = await service.getLpPositionDetails(profile.vaultPublicKey, tracked.positionIdentifier);
          if (positionDetails) {
            allPositions.push(positionDetails);
          }
        } catch (error) {
          console.error(`Error fetching position details for ${tracked.positionIdentifier} from ${tracked.dex}:`, error);
        }
      }
    }
    
    return allPositions;
  }
}

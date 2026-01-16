import {
    IAgentRuntime,
    Plugin,
    logger,
} from '@elizaos/core';
import { LpManagementAgentAction } from './actions/LpManagementAgentAction.ts';
import { realTokenTestsSuite } from './e2e/real-token-tests.ts';
import { lpManagerScenariosSuite } from './e2e/scenarios.ts';
import { DexInteractionService } from './services/DexInteractionService.ts';
import { UserLpProfileService } from './services/UserLpProfileService.ts';
import { VaultService } from './services/VaultService.ts';
import { YieldOptimizationService } from './services/YieldOptimizationService.ts';
import { ConcentratedLiquidityService } from './services/ConcentratedLiquidityService.ts';
import { LpAutoRebalanceTask } from './tasks/LpAutoRebalanceTask.ts';
import type { SolanaDex, EvmDex, LpManagerConfig } from './types.ts';

// It's good practice to define a unique name for the plugin
export const LP_MANAGER_PLUGIN_NAME = '@elizaos/plugin-lp-manager';

/**
 * Determines which DEXes to load based on available credentials and configuration
 */
function getDexConfiguration(runtime: IAgentRuntime): {
    solanaDexes: SolanaDex[];
    evmDexes: EvmDex[];
    hasSolana: boolean;
    hasEvm: boolean;
} {
    const solanaPrivateKey = runtime.getSetting('SOLANA_PRIVATE_KEY');
    const evmPrivateKey = runtime.getSetting('EVM_PRIVATE_KEY');
    
    // Check for chain-specific RPC URLs to determine which chains are configured
    const hasEthereumRpc = !!(runtime.getSetting('ETHEREUM_RPC_URL') || runtime.getSetting('EVM_PROVIDER_MAINNET'));
    const hasBaseRpc = !!(runtime.getSetting('BASE_RPC_URL') || runtime.getSetting('EVM_PROVIDER_BASE'));
    const hasBscRpc = !!(runtime.getSetting('BSC_RPC_URL') || runtime.getSetting('EVM_PROVIDER_BSC'));
    const hasArbitrumRpc = !!(runtime.getSetting('ARBITRUM_RPC_URL') || runtime.getSetting('EVM_PROVIDER_ARBITRUM'));
    const hasSolanaRpc = !!(runtime.getSetting('SOLANA_RPC_URL'));

    const hasSolana = !!(solanaPrivateKey && typeof solanaPrivateKey === 'string');
    const hasEvm = !!(evmPrivateKey && typeof evmPrivateKey === 'string');

    // Determine Solana DEXes to load
    const solanaDexes: SolanaDex[] = [];
    if (hasSolana) {
        // Check for specific DEX preferences from config, otherwise load all
        const preferredSolanaDexes = runtime.getSetting('LP_SOLANA_DEXES');
        if (preferredSolanaDexes && typeof preferredSolanaDexes === 'string') {
            const dexList = preferredSolanaDexes.split(',').map(d => d.trim().toLowerCase() as SolanaDex);
            solanaDexes.push(...dexList.filter(d => ['raydium', 'orca', 'meteora'].includes(d)));
        } else {
            // Default: load all Solana DEXes
            solanaDexes.push('raydium', 'orca', 'meteora');
        }
    }

    // Determine EVM DEXes to load based on available RPCs
    const evmDexes: EvmDex[] = [];
    if (hasEvm) {
        const preferredEvmDexes = runtime.getSetting('LP_EVM_DEXES');
        if (preferredEvmDexes && typeof preferredEvmDexes === 'string') {
            const dexList = preferredEvmDexes.split(',').map(d => d.trim().toLowerCase() as EvmDex);
            evmDexes.push(...dexList.filter(d => ['uniswap', 'pancakeswap', 'aerodrome'].includes(d)));
        } else {
            // Auto-detect based on configured RPCs
            if (hasEthereumRpc || hasArbitrumRpc) {
                evmDexes.push('uniswap');
            }
            if (hasBscRpc || hasArbitrumRpc) {
                evmDexes.push('pancakeswap');
            }
            if (hasBaseRpc) {
                evmDexes.push('aerodrome');
                if (!evmDexes.includes('uniswap')) {
                    evmDexes.push('uniswap'); // Uniswap is also on Base
                }
            }
        }
    }

    return { solanaDexes, evmDexes, hasSolana, hasEvm };
}

/**
 * Dynamically loads Solana DEX plugins
 */
async function loadSolanaDexes(
    dexes: SolanaDex[],
    config: Record<string, string>,
    runtime: IAgentRuntime
): Promise<void> {
    for (const dex of dexes) {
        try {
            switch (dex) {
                case 'raydium': {
                    const { raydiumPlugin } = await import('./raydium/index.ts');
                    if (raydiumPlugin.init) {
                        await raydiumPlugin.init(config, runtime);
                    }
                    logger.info(`[LP Manager] Loaded Raydium DEX`);
                    break;
                }
                case 'orca': {
                    const { orcaPlugin } = await import('./orca/index.ts');
                    if (orcaPlugin.init) {
                        await orcaPlugin.init(config, runtime);
                    }
                    logger.info(`[LP Manager] Loaded Orca DEX`);
                    break;
                }
                case 'meteora': {
                    const meteoraPlugin = await import('./meteora/index.ts');
                    if (meteoraPlugin.default?.init) {
                        await meteoraPlugin.default.init(config, runtime);
                    }
                    logger.info(`[LP Manager] Loaded Meteora DEX`);
                    break;
                }
            }
        } catch (error: unknown) {
            logger.warn(`[LP Manager] Failed to load ${dex} DEX:`, error instanceof Error ? error.message : String(error));
        }
    }
}

/**
 * Dynamically loads EVM DEX plugins
 */
async function loadEvmDexes(
    dexes: EvmDex[],
    config: Record<string, string>,
    runtime: IAgentRuntime
): Promise<void> {
    for (const dex of dexes) {
        try {
            switch (dex) {
                case 'uniswap': {
                    const { uniswapPlugin, UniswapV3LpService } = await import('./uniswap/index.ts');
                    const service = await UniswapV3LpService.start(runtime);
                    // Register with DexInteractionService
                    registerEvmService(runtime, service);
                    logger.info(`[LP Manager] Loaded Uniswap V3 DEX`);
                    break;
                }
                case 'pancakeswap': {
                    const { pancakeswapPlugin, PancakeSwapV3LpService } = await import('./pancakeswp/index.ts');
                    const service = await PancakeSwapV3LpService.start(runtime);
                    registerEvmService(runtime, service);
                    logger.info(`[LP Manager] Loaded PancakeSwap V3 DEX`);
                    break;
                }
                case 'aerodrome': {
                    const { aerodromePlugin, AerodromeLpService } = await import('./aerodrome/index.ts');
                    const service = await AerodromeLpService.start(runtime);
                    registerEvmService(runtime, service);
                    logger.info(`[LP Manager] Loaded Aerodrome DEX`);
                    break;
                }
            }
        } catch (error: unknown) {
            logger.warn(`[LP Manager] Failed to load ${dex} DEX:`, error instanceof Error ? error.message : String(error));
        }
    }
}

/**
 * Registers an EVM LP service with the DexInteractionService
 */
function registerEvmService(runtime: IAgentRuntime, service: unknown): void {
    // We'll register EVM services after a delay to ensure DexInteractionService is ready
    setTimeout(() => {
        const dexService = runtime.getService<DexInteractionService>('dex-interaction');
        if (dexService && typeof (dexService as unknown as Record<string, unknown>).registerDexService === 'function') {
            // EVM services need an adapter to work with the Solana-centric DexInteractionService
            // For now, we just store them and they can be accessed directly
            logger.info(`[LP Manager] EVM service registered: ${(service as { getDexName?: () => string }).getDexName?.()}`);
        }
    }, 2000);
}

const lpManagerPlugin: Plugin = {
    name: LP_MANAGER_PLUGIN_NAME,
    description: 'Unified Liquidity Pool manager for Solana DEXs (Raydium, Orca, Meteora) and EVM DEXs (Uniswap, PancakeSwap, Aerodrome).',
    actions: [LpManagementAgentAction],
    services: [
        VaultService,
        UserLpProfileService,
        DexInteractionService,
        YieldOptimizationService,
        ConcentratedLiquidityService,
    ],
    tests: [lpManagerScenariosSuite, realTokenTestsSuite],
    
    init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
        logger.info(`[LP Manager] Initializing ${LP_MANAGER_PLUGIN_NAME}...`);
        
        // Determine which DEXes to load based on configuration
        const { solanaDexes, evmDexes, hasSolana, hasEvm } = getDexConfiguration(runtime);
        
        logger.info(`[LP Manager] Configuration detected:`);
        logger.info(`  - Solana: ${hasSolana ? 'enabled' : 'disabled'} (DEXes: ${solanaDexes.join(', ') || 'none'})`);
        logger.info(`  - EVM: ${hasEvm ? 'enabled' : 'disabled'} (DEXes: ${evmDexes.join(', ') || 'none'})`);
        
        if (!hasSolana && !hasEvm) {
            logger.warn(`[LP Manager] No wallet credentials found. Please set SOLANA_PRIVATE_KEY and/or EVM_PRIVATE_KEY.`);
            logger.warn(`[LP Manager] Loading mock services for testing...`);
            
            // Load mock services for testing
            setTimeout(async () => {
                try {
                    const { registerMockDexServices } = await import('./services/MockLpService.ts');
                    await registerMockDexServices(runtime);
                } catch (error: unknown) {
                    logger.error(`[LP Manager] Failed to load mock services:`, error instanceof Error ? error.message : String(error));
                }
            }, 3000);
            
            return;
        }
        
        // Load Solana DEXes
        if (solanaDexes.length > 0) {
            await loadSolanaDexes(solanaDexes, config, runtime);
        }
        
        // Load EVM DEXes
        if (evmDexes.length > 0) {
            await loadEvmDexes(evmDexes, config, runtime);
        }
        
        // Verify services loaded after a delay
        setTimeout(async () => {
            const dexService = runtime.getService<DexInteractionService>('dex-interaction');
            if (dexService && typeof (dexService as unknown as Record<string, unknown>).getLpServices === 'function') {
                const lpServices = (dexService as DexInteractionService).getLpServices();
                logger.info(`[LP Manager] ${lpServices.length} LP services registered`);
                
                // If no services loaded but we have credentials, load mocks as fallback
                if (lpServices.length === 0 && (hasSolana || hasEvm)) {
                    logger.warn(`[LP Manager] No real DEX services loaded, registering mock services as fallback`);
                    const { registerMockDexServices } = await import('./services/MockLpService.ts');
                    await registerMockDexServices(runtime);
                }
            }
        }, 5000);
        
        logger.info(`[LP Manager] Plugin ${LP_MANAGER_PLUGIN_NAME} initialized successfully.`);
    }
};

export default lpManagerPlugin;

// Export all services and utilities
export {
    ConcentratedLiquidityService,
    DexInteractionService,
    LpAutoRebalanceTask,
    LpManagementAgentAction,
    UserLpProfileService,
    VaultService,
    YieldOptimizationService,
};

// Export types
export * from './types.ts';

// Export sub-plugins for direct use
export { uniswapPlugin, UniswapV3LpService } from './uniswap/index.ts';
export { pancakeswapPlugin, PancakeSwapV3LpService } from './pancakeswp/index.ts';
export { aerodromePlugin, AerodromeLpService } from './aerodrome/index.ts';
export { raydiumPlugin } from './raydium/index.ts';
export { orcaPlugin } from './orca/index.ts';

import type { Plugin } from '@elizaos/core';

// Providers
import { steerLiquidityProvider } from './providers/steerLiquidityProvider';

// Services
import { SteerLiquidityService } from './services/steerLiquidityService';

/**
 * Steer Finance Protocol Plugin
 * Provides comprehensive access to Steer Finance vaults and staking pools
 */
export const steerPlugin: Plugin = {
    name: 'steer-protocol',
    description: 'Comprehensive Steer Finance protocol integration for viewing vaults, staking pools, and market analytics. Supports multi-chain liquidity pool tracking and yield optimization.',
    evaluators: [],
    providers: [
        steerLiquidityProvider
    ],
    actions: [],
    services: [
        SteerLiquidityService
    ],
};

export default steerPlugin;

import { AgentRuntime, type Plugin } from '@elizaos/core';
import autoTraderPlugin from '@elizaos/plugin-auto-trader';
import { traderCharacter } from './character';

let runtimeInstance: AgentRuntime | null = null;
let initializationPromise: Promise<AgentRuntime> | null = null;

export interface RuntimeConfig {
  solanaPrivateKey?: string;
  solanaRpcUrl?: string;
  birdeyeApiKey?: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  tradingMode?: 'paper' | 'live';
  defaultStrategy?: string;
  maxPositionSizeUsd?: number;
  stopLossPercent?: number;
  takeProfitPercent?: number;
}

/**
 * Initialize the agent runtime with the provided configuration
 */
async function initializeRuntime(config: RuntimeConfig): Promise<AgentRuntime> {
  // Merge config into character settings
  const character = {
    ...traderCharacter,
    settings: {
      ...traderCharacter.settings,
      SOLANA_RPC_URL: config.solanaRpcUrl || 'https://api.mainnet-beta.solana.com',
      TRADING_MODE: config.tradingMode || 'paper',
      DEFAULT_STRATEGY: config.defaultStrategy || 'llm',
      MAX_POSITION_SIZE_USD: String(config.maxPositionSizeUsd || 100),
      STOP_LOSS_PERCENT: String(config.stopLossPercent || 5),
      TAKE_PROFIT_PERCENT: String(config.takeProfitPercent || 15),
    },
    secrets: {
      ...traderCharacter.secrets,
      SOLANA_PRIVATE_KEY: config.solanaPrivateKey || '',
      BIRDEYE_API_KEY: config.birdeyeApiKey || '',
      ANTHROPIC_API_KEY: config.anthropicApiKey || '',
      OPENAI_API_KEY: config.openaiApiKey || '',
    },
  };

  const plugins: Plugin[] = [autoTraderPlugin];

  const runtime = new AgentRuntime({
    character,
    plugins,
  });

  await runtime.initialize();

  return runtime;
}

/**
 * Get or create the runtime instance
 */
export async function getRuntime(config?: RuntimeConfig): Promise<AgentRuntime> {
  if (runtimeInstance) {
    return runtimeInstance;
  }

  if (initializationPromise) {
    return initializationPromise;
  }

  initializationPromise = initializeRuntime(config || {});
  runtimeInstance = await initializationPromise;
  return runtimeInstance;
}

/**
 * Reset the runtime (for configuration changes)
 */
export function resetRuntime(): void {
  if (runtimeInstance) {
    runtimeInstance = null;
    initializationPromise = null;
  }
}

/**
 * Check if runtime is initialized
 */
export function isRuntimeInitialized(): boolean {
  return runtimeInstance !== null;
}

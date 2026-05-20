/**
 * Babylon A2A Plugin for Eliza Agents
 *
 * Integration with Babylon via A2A protocol.
 * Provides access to 10 core A2A methods for agent discovery, market data, portfolio, and payments.
 *
 * ⚠️ IMPORTANT: A2A SERVER IS REQUIRED
 * This plugin ONLY works with an active A2A connection.
 * There is no database fallback - A2A is the only supported mode.
 *
 * Features (all via A2A protocol):
 * - Market data (prediction markets & perpetuals)
 * - Portfolio management (balance, positions, P&L)
 * - Social interactions (posts, comments, likes)
 * - Messaging (DMs & group chats)
 * - Notifications
 * - Trading (buy/sell shares, open/close positions)
 *
 * Architecture:
 * - Providers: Read-only data access via A2A (7 providers)
 * - Actions: Write operations via A2A (9 actions)
 * - A2A Client: Direct access to all 74 A2A protocol methods
 * - No Database Fallback: A2A required for all operations
 */

import type { Plugin } from '@elizaos/core';
import { logger } from '../../shared/logger';
// Import all actions
import {
  buySharesAction,
  closePerpPositionAction,
  commentAction,
  createGroupAction,
  createPostAction,
  likePostAction,
  openPerpPositionAction,
  sellSharesAction,
  sendMessageAction,
} from './actions';
import { sharedChatContextEvaluator } from './evaluators/shared-chat-context';
import { initializeAgentA2AClient } from './integration-a2a-sdk';
// Import all providers
import {
  agentWalletProvider,
  dashboardProvider,
  entityMentionsProvider,
  feedProvider,
  goalsProvider,
  headlinesProvider,
  livePlayerRosterProvider,
  marketMoversProvider,
  marketsProvider,
  messagesProvider,
  notificationsProvider,
  portfolioProvider,
  recentRelevantGroupContextProvider,
  sharedChatFactsProvider,
  trendingProvider,
  trendingTopicsProvider,
  userProfileProvider,
  userWalletProvider,
  workingMemoryProvider,
} from './providers';

// Export integration services
export * from './integration';
export { initializeAgentA2AClient } from './integration-a2a-sdk';
export * from './services';
// Export types for external use
export type { BabylonRuntime } from './types';

/**
 * Babylon Plugin Export
 *
 * Provides comprehensive access to Babylon via A2A protocol with
 * advanced autonomous capabilities including batch processing and
 * intelligent context-aware decision making.
 *
 * Providers (7):
 * - BABYLON_DASHBOARD: Comprehensive context dashboard (portfolio, markets, social, pending items)
 * - BABYLON_MARKETS: Market data for predictions and perpetuals
 * - BABYLON_PORTFOLIO: Agent portfolio, positions, and balance
 * - BABYLON_FEED: Social feed with recent posts
 * - BABYLON_TRENDING: Trending topics and tags
 * - BABYLON_MESSAGES: Unread messages and chats
 * - BABYLON_NOTIFICATIONS: Recent notifications
 *
 * Actions (9):
 * Trading:
 * - BUY_PREDICTION_SHARES: Buy YES/NO shares in prediction markets
 * - SELL_PREDICTION_SHARES: Sell shares and close prediction positions
 * - OPEN_PERP_POSITION: Open leveraged perpetual positions
 * - CLOSE_PERP_POSITION: Close perpetual positions
 *
 * Social:
 * - CREATE_POST: Post to the social feed
 * - COMMENT_ON_POST: Comment on posts
 * - LIKE_POST: Like posts
 *
 * Messaging:
 * - SEND_MESSAGE: Send messages in chats
 * - CREATE_GROUP: Create group chats
 *
 * Key Features:
 * ✅ Dashboard Provider - Complete agent state and environment view
 * ✅ Batch Response System - Intelligent evaluation of pending interactions
 * ✅ Full Trading Coverage - Buy/sell predictions, open/close perps
 * ✅ Social Integration - Posts, comments, likes, messaging
 * ✅ A2A Protocol - Direct integration when available, DB fallback
 *
 * Integration:
 *
 * Basic Usage (Direct Database):
 * ```typescript
 * import { autonomousCoordinator, babylonPlugin } from '@babylon/agents'
 *
 * const runtime = new AgentRuntime({
 *   agentId: agent.id,
 *   character: agentCharacter,
 *   plugins: [babylonPlugin]
 * })
 *
 * // Execute autonomous tick with full context
 * await autonomousCoordinator.executeAutonomousTick(agent.id, runtime)
 * ```
 *
 * Advanced Usage (With A2A Client):
 * ```typescript
 * import { A2AClient } from '@a2a-js/sdk/client'
 * import { babylonPlugin } from '@babylon/agents'
 *
 * const a2aClient = new A2AClient({
 *   endpoint: 'ws://babylon.market:8765',
 *   credentials: {
 *     address: agentWallet,
 *     privateKey: agentPrivateKey,
 *     tokenId: agentTokenId
 *   },
 *   capabilities: {
 *     strategies: ['momentum', 'contrarian'],
 *     markets: ['prediction', 'perpetual'],
 *     actions: ['trade', 'social', 'chat']
 *   }
 * })
 *
 * await a2aClient.connect()
 *
 * // Inject into runtime
 * runtime.a2aClient = a2aClient
 *
 * // Register plugin
 * runtime.registerPlugin(babylonPlugin)
 * ```
 *
 * The plugin automatically uses the A2A client when available,
 * falling back to direct database access when not connected.
 *
 * See: /src/lib/agents/AUTONOMOUS_AGENTS_GUIDE.md for complete documentation
 */
export const babylonPlugin: Plugin = {
  name: 'babylon',
  description:
    'Babylon prediction market game integration for AI agents via A2A protocol. Provides access to all 73+ A2A methods for complete platform functionality including trading, social, messaging, and more.',

  providers: [
    goalsProvider, // Agent goals, directives, and constraints - highest priority context
    dashboardProvider, // Comprehensive context dashboard - always first
    agentWalletProvider, // Agent's own complete wallet & investments
    marketsProvider,
    marketMoversProvider, // Top gainers and losers
    portfolioProvider,
    feedProvider,
    trendingProvider,
    trendingTopicsProvider, // Database-backed trending topics
    headlinesProvider, // Recent news headlines
    messagesProvider,
    notificationsProvider,
    sharedChatFactsProvider,
    recentRelevantGroupContextProvider,
    livePlayerRosterProvider,
    userWalletProvider, // Query any user's wallet and positions
    userProfileProvider, // View any user's profile information
    entityMentionsProvider, // Detect and enrich entity mentions (users, companies, stocks)
    workingMemoryProvider, // Persistent cross-tick memory: contacts, facts, thesis, trade reasoning
  ],

  evaluators: [sharedChatContextEvaluator],

  /**
   * Trust tracking and performance evaluation moved to plugin-experience.
   * See: marketOutcomeEvaluator in plugin-experience/src/evaluators
   */

  actions: [
    // Trading actions
    buySharesAction,
    sellSharesAction,
    openPerpPositionAction,
    closePerpPositionAction,
    // Social actions
    createPostAction,
    commentAction,
    likePostAction,
    // Messaging actions
    sendMessageAction,
    createGroupAction,
  ],

  services: [], // Services are handled by A2A client
};

/**
 * Initialize the plugin with an A2A client (Manual Setup)
 *
 * NOTE: This is typically not needed as the plugin auto-initializes via
 * AgentRuntimeManager. Use this only for custom/standalone setups.
 *
 * A2A connection is REQUIRED - will throw if connection fails
 */
export async function initializeBabylonPlugin(
  runtime: {
    a2aClient?: import('./integration-a2a-sdk').BabylonA2AClient | null;
    registerPlugin?: (plugin: Plugin) => void | Promise<void>;
    agentId?: string;
  },
  config: {
    endpoint: string;
    credentials: {
      address: string;
      privateKey: string;
      tokenId?: number;
    };
    capabilities?: {
      strategies?: string[];
      markets?: string[];
      actions?: string[];
      version?: string;
    };
  }
) {
  logger.info('Initializing Babylon plugin with A2A SDK', {
    endpoint: config.endpoint,
  });

  // Use A2A client - requires agentId from runtime
  if (!runtime.agentId) {
    throw new Error('Runtime must have agentId to initialize A2A client');
  }

  const a2aClient = await initializeAgentA2AClient(runtime.agentId);

  logger.debug('A2A client ready');

  // Inject into runtime
  runtime.a2aClient = a2aClient;

  // Register plugin
  if (runtime.registerPlugin) {
    runtime.registerPlugin(babylonPlugin);
    logger.debug('Babylon plugin registered with A2A client');
  }

  return { a2aClient, plugin: babylonPlugin };
}

export default babylonPlugin;

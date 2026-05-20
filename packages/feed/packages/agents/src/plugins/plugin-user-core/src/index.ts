/**
 * Plugin User Core
 *
 * Core plugin for the user coordinator in team chat.
 * Provides limited actions and context for helping users coordinate their agents.
 *
 * Key differences from plugin-agent-core:
 * - Limited action set (read-only, informational)
 * - No trading, posting, or agent-specific actions
 * - Coordinator context provider for guiding users
 * - All providers are coordinator-specific (not shared with agents)
 *
 * @packageDocumentation
 */

import type { Plugin } from '@elizaos/core';
import {
  checkFeedPostsAction,
  checkPerpsAction,
  checkPredictionsAction,
  checkRecentMarketTradesAction,
  checkTeamChatAction,
  checkUserPnlAction,
  dispatchToAgentAction,
  dispatchToAgentsAction,
  relayToAgentAction,
} from './actions';
import {
  coordinatorActionStateProvider,
  coordinatorActionsProvider,
  coordinatorAgentActivityProvider,
  coordinatorContextProvider,
  coordinatorDispatchHistoryProvider,
  coordinatorRecentMessagesProvider,
  coordinatorTeamMembersProvider,
} from './providers';

/**
 * User Core Plugin
 *
 * Provides capabilities for the user coordinator:
 * - DISPATCH_TO_AGENT - Dispatch commands to child agents (orchestration)
 * - CHECK_PREDICTIONS - Detailed prediction market info
 * - CHECK_PERPS - Perpetual market data
 * - CHECK_USER_PNL - User's balance, positions, P&L
 * - CHECK_TEAM_CHAT - Full team chat history
 * - CHECK_FEED_POSTS - Latest posts from global feed
 * - CHECK_RECENT_MARKET_TRADES - Platform trading activity
 * - Coordinator-specific providers for actions, messages, team members, and context
 */
export const userCorePlugin: Plugin = {
  name: 'user-core',
  description:
    'Core capabilities for user coordinator with orchestration dispatch and read-only informational actions',

  actions: [
    // Orchestration — listed first so the LLM sees it as the primary action for execution requests
    dispatchToAgentAction,
    // Multi-agent orchestration
    dispatchToAgentsAction,
    relayToAgentAction,
    // Market information
    checkPredictionsAction,
    checkPerpsAction,
    // User portfolio
    checkUserPnlAction,
    // Team chat
    checkTeamChatAction,
    // Social & activity
    checkFeedPostsAction,
    checkRecentMarketTradesAction,
  ],

  providers: [
    // Coordinator-specific providers
    coordinatorActionsProvider,
    coordinatorRecentMessagesProvider,
    coordinatorActionStateProvider,
    coordinatorTeamMembersProvider,
    coordinatorContextProvider,
    coordinatorDispatchHistoryProvider,
    coordinatorAgentActivityProvider,
  ],
};

// Export individual components
export {
  checkFeedPostsAction,
  checkPerpsAction,
  checkPredictionsAction,
  checkRecentMarketTradesAction,
  checkTeamChatAction,
  checkUserPnlAction,
  dispatchToAgentAction,
  dispatchToAgentsAction,
  relayToAgentAction,
} from './actions';
export {
  coordinatorActionStateProvider,
  coordinatorActionsProvider,
  coordinatorAgentActivityProvider,
  coordinatorContextProvider,
  coordinatorDispatchHistoryProvider,
  coordinatorRecentMessagesProvider,
  coordinatorTeamMembersProvider,
} from './providers';
export * from './types';

export default userCorePlugin;

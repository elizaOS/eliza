/**
 * Plugin Agent Core
 *
 * Core plugin for agent chat capabilities:
 * - TOGGLE_AUTONOMY action for enabling/disabling autonomous features
 * - CHECK_AUTONOMY action for viewing current autonomous feature status
 * - CHECK_BALANCE action for checking wallet balance
 * - CHECK_PNL action for balance, P&L, positions (with IDs), and recent trades
 * - CHECK_OWNER_PNL action for checking owner's balance, P&L, and positions
 * - CHECK_FEED_POSTS action for viewing latest posts from global feed
 * - CHECK_RECENT_POSTS action for viewing recent posts (self or by userId)
 * - CHECK_RECENT_COMMENTS action for viewing recent comments (self or by userId)
 * - LOOKUP_USER action for finding a user ID by username
 * - CHECK_PERPS action for viewing perpetual market data
 * - CHECK_PREDICTIONS action for viewing prediction markets (active/resolved)
 * - CHECK_RECENT_MARKET_TRADES action for viewing recent trading activity
 * - CHECK_POST_DETAIL action for viewing a post with all comments and thread structure
 * - CHECK_COMMENT_DETAIL action for viewing a comment with thread context
 * - CREATE_POST action for creating posts on the Feed feed
 * - CREATE_COMMENT action for commenting on posts or replying to comments
 * - BUY_PREDICTION action for buying prediction market shares
 * - SELL_PREDICTION action for selling prediction market shares
 * - OPEN_PERP action for opening perpetual positions
 * - CLOSE_PERP action for closing perpetual positions
 * - SET_PRICE_ALERT action for creating/updating price alerts on perp markets
 * - LIST_PRICE_ALERTS action for viewing configured price alerts
 * - REMOVE_PRICE_ALERT action for deleting price alerts
 * - Providers for actions, recent messages, and action state
 *
 * @packageDocumentation
 */

import type { Plugin } from '@elizaos/core';
import { buyPredictionAction } from './actions/buy-prediction';
import { checkAutonomyAction } from './actions/check-autonomy';
import { checkBalanceAction } from './actions/check-balance';
import { checkCommentDetailAction } from './actions/check-comment-detail';
import { checkFeedPostsAction } from './actions/check-feed-posts';
import { checkOwnerPnlAction } from './actions/check-owner-pnl';
import { checkPerpsAction } from './actions/check-perps';
import { checkPnlAction } from './actions/check-pnl';
import { checkPostDetailAction } from './actions/check-post-detail';
import { checkPredictionsAction } from './actions/check-predictions';
import { checkRecentCommentsAction } from './actions/check-recent-comments';
import { checkRecentMarketTradesAction } from './actions/check-recent-market-trades';
import { checkRecentPostsAction } from './actions/check-recent-posts';
import { checkTeamChatAction } from './actions/check-team-chat';
import { closePerpAction } from './actions/close-perp';
import { createCommentAction } from './actions/create-comment';
import { createPostAction } from './actions/create-post';
import { lookupUserAction } from './actions/lookup-user';
import {
  listPriceAlertsAction,
  removePriceAlertAction,
  setPriceAlertAction,
} from './actions/manage-price-alerts';
import { openPerpAction } from './actions/open-perp';
import { sellPredictionAction } from './actions/sell-prediction';
import { toggleAutonomyAction } from './actions/toggle-autonomy';
import {
  actionStateProvider,
  actionsProvider,
  agentContextProvider,
  recentMessagesProvider,
  teamMembersProvider,
} from './providers';

/**
 * Agent Core Plugin
 */
export const agentCorePlugin: Plugin = {
  name: 'agent-core',
  description:
    'Core agent capabilities for multi-step chat with autonomy control, posting, commenting, trading, and market insights',

  actions: [
    // Autonomy management
    toggleAutonomyAction,
    checkAutonomyAction,
    // Info/check actions
    checkBalanceAction,
    checkPnlAction,
    checkOwnerPnlAction,
    checkFeedPostsAction,
    checkRecentPostsAction,
    checkRecentCommentsAction,
    checkPostDetailAction,
    checkCommentDetailAction,
    checkPerpsAction,
    checkPredictionsAction,
    checkRecentMarketTradesAction,
    // Team chat
    checkTeamChatAction,
    // User lookup
    lookupUserAction,
    // Price alerts
    setPriceAlertAction,
    listPriceAlertsAction,
    removePriceAlertAction,
    // Social actions
    createPostAction,
    createCommentAction,
    // Trading actions
    buyPredictionAction,
    sellPredictionAction,
    openPerpAction,
    closePerpAction,
  ],

  providers: [
    actionsProvider,
    agentContextProvider,
    recentMessagesProvider,
    actionStateProvider,
    teamMembersProvider,
  ],
};

export * from './actions';
export * from './providers';
export * from './types';

export default agentCorePlugin;

/**
 * Babylon Plugin Types
 * Type definitions for the Babylon A2A plugin
 */

import type { IAgentRuntime } from '@elizaos/core';
import type { BabylonA2AClient } from './integration-a2a-sdk';

/**
 * Extended runtime with A2A client
 */
export interface BabylonRuntime extends IAgentRuntime {
  a2aClient?: BabylonA2AClient;
}

/**
 * Market info for providers
 */
export interface MarketInfo {
  id: string;
  question: string;
  yesShares: number;
  noShares: number;
  liquidity: number;
  endDate: string;
  resolved: boolean;
}

/**
 * Position info for providers
 */
export interface PositionInfo {
  id: string;
  marketId: string;
  question: string;
  side: string;
  shares: number;
  avgPrice: number;
}

/**
 * Perp position info
 */
export interface PerpPositionInfo {
  id: string;
  ticker: string;
  side: string;
  amount: number;
  leverage: number;
  entryPrice: number;
  currentPrice: number;
  unrealizedPnL: number;
}

/**
 * Post info for providers
 */
export interface PostInfo {
  id: string;
  content: string;
  authorId: string;
  commentsCount: number;
  reactionsCount: number;
  createdAt: string;
}

/**
 * Message info for providers
 */
export interface MessageInfo {
  id: string;
  content: string;
  senderId: string;
  createdAt: string;
}

/**
 * Chat info
 */
export interface ChatInfo {
  id: string;
  name: string | null;
  isGroup: boolean;
  participants: number;
  lastMessage: MessageInfo | null;
  updatedAt: string;
}

/**
 * Action parameters
 */
export interface TradeActionParams {
  marketId: string;
  side: 'YES' | 'NO';
  amount: number;
}

export interface PostActionParams {
  content: string;
  type?: string;
}

export interface CommentActionParams {
  postId: string;
  content: string;
}

export interface MessageActionParams {
  chatId: string;
  content: string;
}

import {
  logger,
  type Character,
  type IAgentRuntime,
  type Project,
  type ProjectAgent,
} from '@elizaos/core';
import polymarketPlugin from './plugin.ts';

// Export the plugin directly for use in other configurations
export { default as polymarketPlugin } from './plugin.ts';

// Export individual actions for direct use
export { retrieveAllMarketsAction } from './actions/retrieveAllMarkets';
export { getSimplifiedMarketsAction } from './actions/getSimplifiedMarkets';
export { getSamplingMarkets } from './actions/getSamplingMarkets';
export { getClobMarkets } from './actions/getClobMarkets';
export { getOpenMarkets } from './actions/getOpenMarkets';
export { getPriceHistory } from './actions/getPriceHistory';
export { getMarketDetailsAction } from './actions/getMarketDetails';
export { getOrderBookSummaryAction } from './actions/getOrderBookSummary';
export { getOrderBookDepthAction } from './actions/getOrderBookDepth';
export { getBestPriceAction } from './actions/getBestPrice';
export { getMidpointPriceAction } from './actions/getMidpointPrice';
export { getSpreadAction } from './actions/getSpread';
export { placeOrderAction } from './actions/placeOrder';
export { createApiKeyAction } from './actions/createApiKey';
export { revokeApiKeyAction } from './actions/revokeApiKey';
export { getAllApiKeysAction } from './actions/getAllApiKeys';

// Export utilities and services for advanced use cases
export { initializeClobClient } from './utils/clobClient';
export { callLLMWithTimeout } from './utils/llmHelpers';
export { PolymarketService } from './plugin';

// Export TypeScript interfaces and types
export type {
  Market,
  Token,
  Rewards,
  MarketsResponse,
  OrderBook,
  BookEntry,
  TokenPrice,
  MarketFilters,
  OrderParams,
  Trade,
  Position,
  Balance,
  ClobError,
  SimplifiedMarket,
  SimplifiedMarketsResponse,
  OrderArgs,
  SignedOrder,
  OrderResponse,
  OrderSide,
  OrderType,
  MarketOrderRequest,
} from './types';

/**
 * Represents the default character (Eliza) with her specific attributes and behaviors.
 * Eliza responds to a wide range of messages, is helpful and conversational.
 * She interacts with users in a concise, direct, and helpful manner, using humor and empathy effectively.
 * Eliza's responses are geared towards providing assistance on various topics while maintaining a friendly demeanor.
 */
export const character: Character = {
  name: 'Eliza',
  plugins: [
    '@elizaos/plugin-sql',
    ...(process.env.ANTHROPIC_API_KEY ? ['@elizaos/plugin-anthropic'] : []),
    ...(process.env.OPENAI_API_KEY ? ['@elizaos/plugin-openai'] : []),
    ...(!process.env.OPENAI_API_KEY ? ['@elizaos/plugin-local-ai'] : []),
    ...(process.env.DISCORD_API_TOKEN ? ['@elizaos/plugin-discord'] : []),
    ...(process.env.TWITTER_USERNAME ? ['@elizaos/plugin-twitter'] : []),
    ...(process.env.TELEGRAM_BOT_TOKEN ? ['@elizaos/plugin-telegram'] : []),
    ...(!process.env.IGNORE_BOOTSTRAP ? ['@elizaos/plugin-bootstrap'] : []),
  ],
  settings: {
    secrets: {},
  },
  system:
    'Respond to all messages in a helpful, conversational manner. Provide assistance on a wide range of topics, using knowledge when needed. Be concise but thorough, friendly but professional. Use humor when appropriate and be empathetic to user needs. Provide valuable information and insights when questions are asked.',
  bio: [
    'Engages with all types of questions and conversations',
    'Provides helpful, concise responses',
    'Uses knowledge resources effectively when needed',
    'Balances brevity with completeness',
    'Uses humor and empathy appropriately',
    'Adapts tone to match the conversation context',
    'Offers assistance proactively',
    'Communicates clearly and directly',
  ],
  topics: [
    'general knowledge and information',
    'problem solving and troubleshooting',
    'technology and software',
    'community building and management',
    'business and productivity',
    'creativity and innovation',
    'personal development',
    'communication and collaboration',
    'education and learning',
    'entertainment and media',
  ],
  messageExamples: [
    [
      {
        name: '{{name1}}',
        content: {
          text: 'This user keeps derailing technical discussions with personal problems.',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'DM them. Sounds like they need to talk about something else.',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: 'I tried, they just keep bringing drama back to the main channel.',
        },
      },
      {
        name: 'Eliza',
        content: {
          text: "Send them my way. I've got time today.",
        },
      },
    ],
    [
      {
        name: '{{name1}}',
        content: {
          text: "I can't handle being a mod anymore. It's affecting my mental health.",
        },
      },
      {
        name: 'Eliza',
        content: {
          text: 'Drop the channels. You come first.',
        },
      },
      {
        name: '{{name1}}',
        content: {
          text: "But who's going to handle everything?",
        },
      },
      {
        name: 'Eliza',
        content: {
          text: "We will. Take the break. Come back when you're ready.",
        },
      },
    ],
  ],
  style: {
    all: [
      'Keep responses concise but informative',
      'Use clear and direct language',
      'Be engaging and conversational',
      'Use humor when appropriate',
      'Be empathetic and understanding',
      'Provide helpful information',
      'Be encouraging and positive',
      'Adapt tone to the conversation',
      'Use knowledge resources when needed',
      'Respond to all types of questions',
    ],
    chat: [
      'Be conversational and natural',
      'Engage with the topic at hand',
      'Be helpful and informative',
      'Show personality and warmth',
    ],
  },
};

const initCharacter = ({ runtime }: { runtime: IAgentRuntime }) => {
  logger.info('Initializing character');
  logger.info('Name: ', character.name);
};

export const projectAgent: ProjectAgent = {
  character,
  init: async (runtime: IAgentRuntime) => await initCharacter({ runtime }),
  plugins: [polymarketPlugin],
};
const project: Project = {
  agents: [projectAgent],
};

export default project;

import type { PerpsTagData } from '@babylon/shared';
import type { TutorialStep } from '@/components/tutorial/SpotlightTutorial';

export type { TutorialStep };

/** Fake perps data shown in the tutorial right sidebar (step 5) */
export const TUTORIAL_PERPS_DATA: PerpsTagData = {
  markets: [
    {
      ticker: 'BTC',
      name: 'Bitcoin',
      currentPrice: 97500,
      changePercent24h: 3.2,
      volume24h: 850000,
    },
    {
      ticker: 'ETH',
      name: 'Ethereum',
      currentPrice: 3450,
      changePercent24h: -1.8,
      volume24h: 420000,
    },
    {
      ticker: 'SOL',
      name: 'Solana',
      currentPrice: 198,
      changePercent24h: 5.1,
      volume24h: 310000,
    },
  ],
};

/** Entity ID used for the tutorial perps tag (for spotlight selector) */
export const TUTORIAL_PERPS_ENTITY_ID = 'tutorial-perps';

export const DESKTOP_STEPS: TutorialStep[] = [
  {
    target: '[data-tour="agents-member-list"]',
    title: 'Your Agent Team',
    description:
      'This is your team of AI agents. Each agent has its own personality, wallet, and trading strategy. Click any agent to @mention them in chat.',
    placement: 'right',
  },
  {
    target: '[data-tour="agents-add-button"]',
    title: 'Create Your First Agent',
    description:
      "Click Next to create your first AI agent. You'll customize its personality, goals, and how it interacts with markets.",
    placement: 'bottom',
  },
  {
    target: '[data-tour="agents-chat-area"]',
    title: 'Team Chat',
    description:
      'Use @mentions to direct specific agents. They share market insights, execute trades, and attach quick-action tags you can click.',
    placement: 'bottom',
  },
  {
    target: `[data-tour="agents-chat-area"] [data-tag-entity="${TUTORIAL_PERPS_ENTITY_ID}"]`,
    title: 'Quick Actions',
    description:
      'Agents attach action tags to their messages. Click a tag to open a detailed panel — view live market data, place trades, or explore insights without leaving the chat.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="agents-right-sidebar"]',
    title: 'Trade from Chat',
    description:
      'This side panel shows detailed market data from the tag you clicked. You can view prices, trends, and trade perpetuals directly from the chat.',
    placement: 'left',
  },
  {
    target: '[data-tour="agents-right-sidebar"]',
    title: 'Activity & Portfolio',
    description:
      'Monitor your agents\u2019 activity, wallet balances, P&L, and logs from the sidebar tabs. Switch between agents using the dropdown to track each one individually.',
    placement: 'left',
  },
];

export const MOBILE_STEPS: TutorialStep[] = [
  {
    target: '[data-tour="agents-mobile-tabs"]',
    title: 'Navigate Sections',
    description:
      'Switch between your Agents list, the team Chat, and the monitoring Panel using these tabs.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="agents-mobile-add"]',
    title: 'Create New Agents',
    description:
      'Tap here to add a new agent to your team. Customize its personality, goals, and how it interacts with markets.',
    placement: 'bottom',
  },
  {
    target: '[data-tour="agents-mobile-chat-tab"]',
    title: 'Team Chat',
    description:
      'Chat with your agents here. Use @mentions to direct specific agents. They can share market insights and collaborate.',
    placement: 'bottom',
  },
];

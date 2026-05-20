/**
 * Achievement & Challenge Definitions
 *
 * Source of truth for all achievement and challenge seed data.
 * Used by:
 *   - Seed script to populate AchievementDefinition / ChallengeDefinition tables
 *   - AchievementService to map trackingTypes to event types
 *   - Frontend for static metadata (icons, categories)
 */

// ── Types ──────────────────────────────────────────────────────────

export type AchievementTier = 'bronze' | 'silver' | 'gold';
export type AchievementCategory =
  | 'trading'
  | 'agents'
  | 'exploration'
  | 'social';
export type ChallengePool = 'daily' | 'weekly';

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  category: AchievementCategory;
  tier: AchievementTier;
  iconKey: string;
  pointsReward: number;
  threshold: number;
  trackingType: string;
  sortOrder: number;
}

export interface ChallengeDef {
  id: string;
  name: string;
  description: string;
  pool: ChallengePool;
  category: string;
  iconKey: string;
  pointsReward: number;
  threshold: number;
  trackingType: string;
  sortOrder: number;
  hint: string;
}

// ── Achievement Event Types ────────────────────────────────────────
// Maps each event emitted by route handlers to the trackingTypes it can advance.

export type AchievementEventType =
  | 'prediction_trade'
  | 'perp_trade'
  | 'prediction_win'
  | 'post_created'
  | 'comment_created'
  | 'group_message_sent'
  | 'agent_created'
  | 'agent_message_sent'
  | 'agent_trade_executed'
  | 'follow_created'
  | 'reaction_created'
  | 'share_created'
  | 'group_joined'
  | 'group_created'
  | 'daily_login'
  | 'page_visited';

export type AchievementEvent =
  | { type: 'prediction_trade'; marketId: string }
  | { type: 'perp_trade'; ticker: string }
  | { type: 'prediction_win' }
  | { type: 'post_created' }
  | { type: 'comment_created' }
  | { type: 'group_message_sent' }
  | { type: 'agent_created' }
  | { type: 'agent_message_sent' }
  | { type: 'agent_trade_executed' }
  | { type: 'follow_created' }
  | { type: 'reaction_created' }
  | { type: 'share_created' }
  | { type: 'group_joined' }
  | { type: 'group_created' }
  | { type: 'daily_login'; streak: number }
  | { type: 'page_visited'; activityType: string };

/**
 * Maps an event type to the trackingTypes it may advance.
 * Used by AchievementEngine to filter which achievements/challenges
 * need to be checked when a specific event fires.
 */
export const EVENT_TO_TRACKING_TYPES: Record<AchievementEventType, string[]> = {
  prediction_trade: [
    'prediction_trade_count',
    'total_trade_count',
    'distinct_markets',
    // daily/weekly challenge types
    'daily_pred_trade',
    'daily_total_trade',
    'daily_distinct_markets',
    'daily_pred_and_perp',
    'weekly_pred_trade',
    'weekly_total_trade',
    'weekly_distinct_markets',
    'weekly_pred_and_perp',
    'weekly_trade_days',
    'weekly_top_market',
  ],
  perp_trade: [
    'perp_trade_count',
    'total_trade_count',
    // daily/weekly
    'daily_perp_trade',
    'daily_total_trade',
    'daily_pred_and_perp',
    'weekly_perp_trade',
    'weekly_total_trade',
    'weekly_pred_and_perp',
    'weekly_trade_days',
  ],
  prediction_win: [
    'prediction_win_count',
    'weekly_trade_win',
    'weekly_positive_pnl',
  ],
  post_created: ['daily_post', 'weekly_post', 'weekly_feed_engage'],
  comment_created: [
    'comment_count',
    'daily_comment',
    'weekly_comment',
    'weekly_feed_engage',
  ],
  group_message_sent: [
    'group_message_count',
    'daily_group_message',
    'weekly_group_message',
    'weekly_agent_and_group',
  ],
  agent_created: ['agent_count', 'weekly_agent_interact'],
  agent_message_sent: [
    'agent_message_count',
    'daily_agent_message',
    'weekly_agent_message',
    'weekly_agent_interact',
    'weekly_agent_and_group',
  ],
  agent_trade_executed: ['agent_trade_count', 'weekly_agent_trade'],
  follow_created: ['daily_follow', 'weekly_follow'],
  reaction_created: ['daily_reaction', 'weekly_reaction', 'weekly_feed_engage'],
  share_created: ['daily_share', 'weekly_share'],
  group_joined: ['daily_group_join', 'weekly_group_join'],
  group_created: ['weekly_group_create'],
  daily_login: ['login_streak', 'weekly_login_days', 'weekly_referral_play'],
  page_visited: [
    'terminal_visit_count',
    'agents_visit_count',
    'daily_terminal_visit',
    'daily_agents_visit',
    'daily_markets_visit',
    'daily_feed_visit',
    'daily_leaderboard_visit',
    'daily_notifications_visit',
    'daily_market_detail_visit',
  ],
};

/**
 * Valid page-visit activity types that can be written to UserActivityLog.
 * Used by the heartbeat route to validate client-submitted page contexts.
 */
export const VALID_PAGE_ACTIVITY_TYPES = [
  'open_terminal',
  'open_agents',
  'open_markets',
  'open_feed',
  'open_leaderboard',
  'open_notifications',
  'open_market_detail',
] as const;

export type PageActivityType = (typeof VALID_PAGE_ACTIVITY_TYPES)[number];

/**
 * Maps URL pathname prefixes to activity types.
 * Used client-side in useSessionHeartbeat to classify page visits.
 */
export const PATH_TO_ACTIVITY_TYPE: Record<string, PageActivityType> = {
  '/markets': 'open_terminal',
  '/agents': 'open_agents',
  '/feed': 'open_feed',
  '/leaderboard': 'open_leaderboard',
  '/notifications': 'open_notifications',
};

// ── Achievement Definitions (15 total: 8 Bronze + 5 Silver + 2 Gold) ──

export const ACHIEVEMENT_DEFINITIONS: AchievementDef[] = [
  // Bronze (8) — first-time actions, 60-80% expected completion
  {
    id: 'first_prediction_trade',
    name: 'First Prediction',
    description: 'Make your first prediction trade',
    category: 'trading',
    tier: 'bronze',
    iconKey: 'target',
    pointsReward: 75,
    threshold: 1,
    trackingType: 'prediction_trade_count',
    sortOrder: 1,
  },
  {
    id: 'first_perp_trade',
    name: 'First Perp',
    description: 'Make your first perpetual trade',
    category: 'trading',
    tier: 'bronze',
    iconKey: 'trending-up',
    pointsReward: 75,
    threshold: 1,
    trackingType: 'perp_trade_count',
    sortOrder: 2,
  },
  {
    id: 'first_agent',
    name: 'Agent Creator',
    description: 'Create your first agent',
    category: 'agents',
    tier: 'bronze',
    iconKey: 'bot',
    pointsReward: 100,
    threshold: 1,
    trackingType: 'agent_count',
    sortOrder: 3,
  },
  {
    id: 'first_agent_message',
    name: 'Chat with Agent',
    description: 'Send your first message to an agent',
    category: 'agents',
    tier: 'bronze',
    iconKey: 'message-square',
    pointsReward: 50,
    threshold: 1,
    trackingType: 'agent_message_count',
    sortOrder: 4,
  },
  {
    id: 'terminal_explorer',
    name: 'Terminal Explorer',
    description: 'Visit the Terminal page',
    category: 'exploration',
    tier: 'bronze',
    iconKey: 'monitor',
    pointsReward: 50,
    threshold: 1,
    trackingType: 'terminal_visit_count',
    sortOrder: 5,
  },
  {
    id: 'agents_explorer',
    name: 'Agents Explorer',
    description: 'Visit the Agents page',
    category: 'exploration',
    tier: 'bronze',
    iconKey: 'users',
    pointsReward: 50,
    threshold: 1,
    trackingType: 'agents_visit_count',
    sortOrder: 6,
  },
  {
    id: 'group_chatter',
    name: 'Group Chatter',
    description: 'Send a message in a group chat',
    category: 'social',
    tier: 'bronze',
    iconKey: 'messages-square',
    pointsReward: 75,
    threshold: 1,
    trackingType: 'group_message_count',
    sortOrder: 7,
  },
  {
    id: 'feed_commenter',
    name: 'Feed Commenter',
    description: 'Leave your first comment on a post',
    category: 'social',
    tier: 'bronze',
    iconKey: 'message-circle',
    pointsReward: 50,
    threshold: 1,
    trackingType: 'comment_count',
    sortOrder: 8,
  },

  // Silver (5) — intermediate milestones, 20-40% expected completion
  {
    id: 'five_markets',
    name: 'Five Markets',
    description: 'Trade in 5 different markets',
    category: 'trading',
    tier: 'silver',
    iconKey: 'bar-chart-3',
    pointsReward: 150,
    threshold: 5,
    trackingType: 'distinct_markets',
    sortOrder: 9,
  },
  {
    id: 'ten_trades',
    name: 'Active Trader',
    description: 'Complete 10 trades (prediction or perp)',
    category: 'trading',
    tier: 'silver',
    iconKey: 'activity',
    pointsReward: 100,
    threshold: 10,
    trackingType: 'total_trade_count',
    sortOrder: 10,
  },
  {
    id: 'first_win',
    name: 'First Win',
    description: 'Win your first resolved prediction',
    category: 'trading',
    tier: 'silver',
    iconKey: 'trophy',
    pointsReward: 150,
    threshold: 1,
    trackingType: 'prediction_win_count',
    sortOrder: 11,
  },
  {
    id: 'three_agents',
    name: 'Agent Squad',
    description: 'Create 3 agents',
    category: 'agents',
    tier: 'silver',
    iconKey: 'cpu',
    pointsReward: 200,
    threshold: 3,
    trackingType: 'agent_count',
    sortOrder: 12,
  },
  {
    id: 'agent_trader',
    name: 'Agent Trader',
    description: 'Have an agent execute a trade',
    category: 'agents',
    tier: 'silver',
    iconKey: 'bot-message-square',
    pointsReward: 150,
    threshold: 1,
    trackingType: 'agent_trade_count',
    sortOrder: 13,
  },

  // Gold (2) — expert milestones, 5-15% expected completion
  {
    id: 'twenty_five_markets',
    name: 'Market Veteran',
    description: 'Trade in 25 different markets',
    category: 'trading',
    tier: 'gold',
    iconKey: 'crown',
    pointsReward: 300,
    threshold: 25,
    trackingType: 'distinct_markets',
    sortOrder: 14,
  },
  {
    id: 'seven_day_streak',
    name: 'Week Trader',
    description: 'Maintain a 7-day login streak',
    category: 'trading',
    tier: 'gold',
    iconKey: 'flame',
    pointsReward: 250,
    threshold: 7,
    trackingType: 'login_streak',
    sortOrder: 15,
  },
];

// ── Challenge Definitions (20 daily + 20 weekly) ──

export const DAILY_CHALLENGE_DEFINITIONS: ChallengeDef[] = [
  {
    id: 'daily_place_prediction',
    name: 'Predict Something',
    description: 'Place a prediction trade',
    pool: 'daily',
    category: 'trading',
    iconKey: 'target',
    pointsReward: 50,
    threshold: 1,
    trackingType: 'daily_pred_trade',
    sortOrder: 1,
    hint: 'Go to Terminal \u2192 Predictions tab \u2192 tap YES or NO on any market',
  },
  {
    id: 'daily_place_perp',
    name: 'Go Perp',
    description: 'Open a perpetual position',
    pool: 'daily',
    category: 'trading',
    iconKey: 'trending-up',
    pointsReward: 50,
    threshold: 1,
    trackingType: 'daily_perp_trade',
    sortOrder: 2,
    hint: 'Go to Terminal \u2192 Perpetuals tab \u2192 pick a ticker \u2192 tap Long or Short',
  },
  {
    id: 'daily_agent_message',
    name: 'Agent Chat',
    description: 'Send a message to an agent',
    pool: 'daily',
    category: 'agents',
    iconKey: 'bot',
    pointsReward: 35,
    threshold: 1,
    trackingType: 'daily_agent_message',
    sortOrder: 3,
    hint: 'Go to Agents \u2192 open any agent\u2019s chat \u2192 send a message',
  },
  {
    id: 'daily_open_terminal',
    name: 'Open Terminal',
    description: 'Visit the Terminal page',
    pool: 'daily',
    category: 'exploration',
    iconKey: 'monitor',
    pointsReward: 25,
    threshold: 1,
    trackingType: 'daily_terminal_visit',
    sortOrder: 4,
    hint: 'Open Terminal from the navigation \u2014 just visiting counts!',
  },
  {
    id: 'daily_open_agents',
    name: 'Visit Agents',
    description: 'Visit the Agents page',
    pool: 'daily',
    category: 'exploration',
    iconKey: 'users',
    pointsReward: 25,
    threshold: 1,
    trackingType: 'daily_agents_visit',
    sortOrder: 5,
    hint: 'Open Agents from the navigation \u2014 just visiting counts!',
  },
  {
    id: 'daily_comment_post',
    name: 'Leave a Comment',
    description: 'Comment on a post in the feed',
    pool: 'daily',
    category: 'social',
    iconKey: 'message-circle',
    pointsReward: 40,
    threshold: 1,
    trackingType: 'daily_comment',
    sortOrder: 6,
    hint: 'Open any post in the feed \u2192 write a reply in the comment box',
  },
  {
    id: 'daily_like_post',
    name: 'Like a Post',
    description: 'Like a post in the feed',
    pool: 'daily',
    category: 'social',
    iconKey: 'heart',
    pointsReward: 25,
    threshold: 1,
    trackingType: 'daily_reaction',
    sortOrder: 7,
    hint: 'Scroll the feed \u2192 tap the heart or "+ React" on any post',
  },
  {
    id: 'daily_visit_markets',
    name: 'Browse Markets',
    description: 'Visit the markets page',
    pool: 'daily',
    category: 'exploration',
    iconKey: 'bar-chart-3',
    pointsReward: 30,
    threshold: 1,
    trackingType: 'daily_markets_visit',
    sortOrder: 8,
    hint: 'Open Terminal and browse markets \u2014 just visiting counts!',
  },
  {
    id: 'daily_create_post',
    name: 'Share Your Take',
    description: 'Create a post',
    pool: 'daily',
    category: 'social',
    iconKey: 'pen-line',
    pointsReward: 45,
    threshold: 1,
    trackingType: 'daily_post',
    sortOrder: 9,
    hint: 'Tap the compose button in the feed \u2192 write and publish a post',
  },
  {
    id: 'daily_group_message',
    name: 'Group Talk',
    description: 'Send a message in a group chat',
    pool: 'daily',
    category: 'social',
    iconKey: 'messages-square',
    pointsReward: 40,
    threshold: 1,
    trackingType: 'daily_group_message',
    sortOrder: 10,
    hint: 'Go to Chats \u2192 open any group \u2192 send a message',
  },
  {
    id: 'daily_two_trades',
    name: 'Double Down',
    description: 'Place 2 trades (any type)',
    pool: 'daily',
    category: 'trading',
    iconKey: 'repeat',
    pointsReward: 55,
    threshold: 2,
    trackingType: 'daily_total_trade',
    sortOrder: 11,
    hint: 'Place any 2 trades today \u2014 predictions and perps both count',
  },
  {
    id: 'daily_pred_and_perp',
    name: 'Both Sides',
    description: 'Place a prediction AND a perp trade',
    pool: 'daily',
    category: 'trading',
    iconKey: 'split',
    pointsReward: 65,
    threshold: 1,
    trackingType: 'daily_pred_and_perp',
    sortOrder: 12,
    hint: 'Place one prediction trade AND one perp trade \u2014 need both types',
  },
  {
    id: 'daily_three_markets',
    name: 'Market Sampler',
    description: 'Trade in 3 different markets',
    pool: 'daily',
    category: 'trading',
    iconKey: 'layout-grid',
    pointsReward: 35,
    threshold: 3,
    trackingType: 'daily_distinct_markets',
    sortOrder: 13,
    hint: 'Trade in 3 separate markets today \u2014 different tickers needed',
  },
  {
    id: 'daily_agent_chat',
    name: 'Agent Deep Dive',
    description: 'Have a 3-message conversation with an agent',
    pool: 'daily',
    category: 'agents',
    iconKey: 'bot-message-square',
    pointsReward: 30,
    threshold: 3,
    trackingType: 'daily_agent_message',
    sortOrder: 14,
    hint: 'Send 3 messages to any agent \u2014 have a real conversation',
  },
  {
    id: 'daily_follow_user',
    name: 'New Connection',
    description: 'Follow a new user',
    pool: 'daily',
    category: 'social',
    iconKey: 'user-plus',
    pointsReward: 25,
    threshold: 1,
    trackingType: 'daily_follow',
    sortOrder: 15,
    hint: 'Find a player in the feed or leaderboard \u2192 tap Follow',
  },
  {
    id: 'daily_check_feed',
    name: 'Feed Check',
    description: 'Visit the feed',
    pool: 'daily',
    category: 'exploration',
    iconKey: 'rss',
    pointsReward: 25,
    threshold: 1,
    trackingType: 'daily_feed_visit',
    sortOrder: 16,
    hint: 'Open Home from the navigation \u2014 just visiting counts!',
  },
  {
    id: 'daily_reply_comment',
    name: 'Join Discussion',
    description: "Reply to someone's comment",
    pool: 'daily',
    category: 'social',
    iconKey: 'reply',
    pointsReward: 40,
    threshold: 1,
    trackingType: 'daily_comment',
    sortOrder: 17,
    hint: 'Find a comment on any post \u2192 tap reply \u2192 write your response',
  },
  {
    id: 'daily_open_market',
    name: 'Market Scout',
    description: 'Open a market detail page',
    pool: 'daily',
    category: 'exploration',
    iconKey: 'search',
    pointsReward: 30,
    threshold: 1,
    trackingType: 'daily_market_detail_visit',
    sortOrder: 18,
    hint: 'Tap into any specific market to see its detail page',
  },
  {
    id: 'daily_leaderboard',
    name: 'Check Rankings',
    description: 'Visit the leaderboard',
    pool: 'daily',
    category: 'exploration',
    iconKey: 'medal',
    pointsReward: 25,
    threshold: 1,
    trackingType: 'daily_leaderboard_visit',
    sortOrder: 19,
    hint: 'Open Leaderboard from the navigation \u2014 just visiting counts!',
  },
  {
    id: 'daily_notifications',
    name: 'Stay Informed',
    description: 'Check your notifications',
    pool: 'daily',
    category: 'exploration',
    iconKey: 'bell',
    pointsReward: 25,
    threshold: 1,
    trackingType: 'daily_notifications_visit',
    sortOrder: 20,
    hint: 'Open Notifications from the navigation \u2014 just checking counts!',
  },
];

export const WEEKLY_CHALLENGE_DEFINITIONS: ChallengeDef[] = [
  {
    id: 'weekly_five_markets',
    name: 'Market Explorer',
    description: 'Trade in 5 different markets',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'bar-chart-3',
    pointsReward: 150,
    threshold: 5,
    trackingType: 'weekly_distinct_markets',
    sortOrder: 1,
    hint: 'Place trades in 5 separate markets this week \u2014 any trade type',
  },
  {
    id: 'weekly_agent_trade',
    name: 'Agent Profit',
    description: 'Have an agent execute a trade',
    pool: 'weekly',
    category: 'agents',
    iconKey: 'bot',
    pointsReward: 200,
    threshold: 1,
    trackingType: 'weekly_agent_trade',
    sortOrder: 2,
    hint: 'Command your agent to trade (e.g. "open a position in METAI")',
  },
  {
    id: 'weekly_group_chat',
    name: 'Group Regular',
    description: 'Send 10 messages in group chats',
    pool: 'weekly',
    category: 'social',
    iconKey: 'messages-square',
    pointsReward: 120,
    threshold: 10,
    trackingType: 'weekly_group_message',
    sortOrder: 3,
    hint: 'Send messages in group chats \u2014 10 total across all groups',
  },
  {
    id: 'weekly_two_wins',
    name: 'Double Win',
    description: 'Win 2 resolved predictions',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'trophy',
    pointsReward: 180,
    threshold: 2,
    trackingType: 'weekly_trade_win',
    sortOrder: 4,
    hint: 'Place prediction trades \u2192 2 must resolve in your favor',
  },
  {
    id: 'weekly_both_types',
    name: 'Both Sides Pro',
    description: 'Trade both predictions and perps',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'split',
    pointsReward: 150,
    threshold: 1,
    trackingType: 'weekly_pred_and_perp',
    sortOrder: 5,
    hint: 'Place at least 1 prediction trade AND 1 perp trade this week',
  },
  {
    id: 'weekly_ten_trades',
    name: 'Active Trader',
    description: 'Complete 10 trades',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'activity',
    pointsReward: 130,
    threshold: 10,
    trackingType: 'weekly_total_trade',
    sortOrder: 6,
    hint: 'Make 10 trades this week \u2014 predictions and perps both count',
  },
  {
    id: 'weekly_three_agents',
    name: 'Agent Collector',
    description: 'Create or interact with 3 agents',
    pool: 'weekly',
    category: 'agents',
    iconKey: 'cpu',
    pointsReward: 200,
    threshold: 3,
    trackingType: 'weekly_agent_interact',
    sortOrder: 7,
    hint: 'Create new agents or send messages to 3 different agents',
  },
  {
    id: 'weekly_agent_chat_5',
    name: 'Agent Conversationalist',
    description: 'Have 5 agent conversations',
    pool: 'weekly',
    category: 'agents',
    iconKey: 'bot-message-square',
    pointsReward: 100,
    threshold: 5,
    trackingType: 'weekly_agent_message',
    sortOrder: 8,
    hint: 'Send messages to agents 5 times \u2014 can be same or different agents',
  },
  {
    id: 'weekly_five_comments',
    name: 'Discussion Driver',
    description: 'Leave 5 comments on posts',
    pool: 'weekly',
    category: 'social',
    iconKey: 'message-circle',
    pointsReward: 120,
    threshold: 5,
    trackingType: 'weekly_comment',
    sortOrder: 9,
    hint: 'Comment on 5 different posts in the feed this week',
  },
  {
    id: 'weekly_three_posts',
    name: 'Content Creator',
    description: 'Create 3 posts',
    pool: 'weekly',
    category: 'social',
    iconKey: 'pen-line',
    pointsReward: 150,
    threshold: 3,
    trackingType: 'weekly_post',
    sortOrder: 10,
    hint: 'Write and publish 3 posts in the feed this week',
  },
  {
    id: 'weekly_seven_markets',
    name: 'Market Veteran',
    description: 'Trade in 7 different markets',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'crown',
    pointsReward: 200,
    threshold: 7,
    trackingType: 'weekly_distinct_markets',
    sortOrder: 11,
    hint: 'Trade in 7 separate markets this week \u2014 different tickers needed',
  },
  {
    id: 'weekly_positive_pnl',
    name: 'In the Green',
    description: 'End the week with positive PnL',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'trending-up',
    pointsReward: 180,
    threshold: 1,
    trackingType: 'weekly_positive_pnl',
    sortOrder: 12,
    hint: 'Win more than you lose \u2014 check your P&L in the wallet',
  },
  {
    id: 'weekly_group_create',
    name: 'Group Leader',
    description: 'Create a group chat',
    pool: 'weekly',
    category: 'social',
    iconKey: 'users-round',
    pointsReward: 150,
    threshold: 1,
    trackingType: 'weekly_group_create',
    sortOrder: 13,
    hint: 'Go to Chats \u2192 create a new group chat',
  },
  {
    id: 'weekly_feed_engage',
    name: 'Feed Engaged',
    description: 'Like + comment on 3 posts each',
    pool: 'weekly',
    category: 'social',
    iconKey: 'heart',
    pointsReward: 80,
    threshold: 3,
    trackingType: 'weekly_feed_engage',
    sortOrder: 14,
    hint: 'Like at least 3 posts AND comment on at least 3 posts',
  },
  {
    id: 'weekly_perp_only',
    name: 'Perp Specialist',
    description: 'Open 3 perp positions',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'candlestick-chart',
    pointsReward: 140,
    threshold: 3,
    trackingType: 'weekly_perp_trade',
    sortOrder: 15,
    hint: 'Open 3 positions in Perpetuals \u2014 Long or Short on any ticker',
  },
  {
    id: 'weekly_pred_only',
    name: 'Prediction Master',
    description: 'Place 5 prediction trades',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'target',
    pointsReward: 100,
    threshold: 5,
    trackingType: 'weekly_pred_trade',
    sortOrder: 16,
    hint: 'Place 5 YES/NO prediction trades on any markets',
  },
  {
    id: 'weekly_agent_in_group',
    name: 'Agent + Group',
    description: 'Message an agent AND a group chat',
    pool: 'weekly',
    category: 'agents',
    iconKey: 'link',
    pointsReward: 220,
    threshold: 1,
    trackingType: 'weekly_agent_and_group',
    sortOrder: 17,
    hint: 'Send at least 1 agent message AND 1 group chat message',
  },
  {
    id: 'weekly_five_days',
    name: 'Consistent Player',
    description: 'Log in 5 days this week',
    pool: 'weekly',
    category: 'exploration',
    iconKey: 'calendar-check',
    pointsReward: 160,
    threshold: 5,
    trackingType: 'weekly_login_days',
    sortOrder: 18,
    hint: 'Just log in on 5 different days this week \u2014 play anything',
  },
  {
    id: 'weekly_referral_play',
    name: 'Bring a Friend',
    description: 'Refer someone who makes a trade',
    pool: 'weekly',
    category: 'social',
    iconKey: 'user-plus',
    pointsReward: 250,
    threshold: 1,
    trackingType: 'weekly_referral_play',
    sortOrder: 19,
    hint: 'Share your referral link \u2192 they must sign up AND place a trade',
  },
  {
    id: 'weekly_top_market',
    name: 'Top Market',
    description: 'Trade in the highest-volume market',
    pool: 'weekly',
    category: 'trading',
    iconKey: 'star',
    pointsReward: 170,
    threshold: 1,
    trackingType: 'weekly_top_market',
    sortOrder: 20,
    hint: 'Trade in the most-traded market this week \u2014 check Terminal',
  },
];

export const ALL_CHALLENGE_DEFINITIONS: ChallengeDef[] = [
  ...DAILY_CHALLENGE_DEFINITIONS,
  ...WEEKLY_CHALLENGE_DEFINITIONS,
];

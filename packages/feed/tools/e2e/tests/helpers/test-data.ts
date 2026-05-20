/**
 * Test data constants for E2E tests
 */

export const ROUTES = {
  HOME: '/',
  FEED: '/feed',
  CHATS: '/chats',
  PROFILE: '/profile',
  PROFILE_BY_ID: (id: string) => `/profile/${id}`,
  MARKETS: '/markets',
  MARKETS_PERPS: '/markets?tab=perps',
  MARKETS_PERPS_BY_TICKER: (ticker: string) => `/markets/perps/${ticker}`,
  MARKETS_PREDICTIONS: '/markets?tab=predictions',
  MARKETS_PREDICTIONS_BY_ID: (id: string) => `/markets/predictions/${id}`,
  BETTING: '/betting',
  GAME: '/game',
  LEADERBOARD: '/leaderboard',
  NOTIFICATIONS: '/notifications',
  REWARDS: '/rewards',
  REPUTATION: '/reputation',
  REGISTRY: '/registry',
  SETTINGS: '/settings',
  WALLET: '/wallet',
  NFT: '/nft',
  RESEARCH: '/research',
  AGENTS: '/agents',
  AGENTS_CREATE: '/agents/create',
  AGENTS_BY_ID: (id: string) => `/agents/${id}`,
  AGENTS_TEAM_CHAT: '/agents/team',
  POST_BY_ID: (id: string) => `/post/${id}`,
  ARTICLE_BY_ID: (id: string) => `/article/${id}`,
  TRENDING_BY_TAG: (tag: string) => `/trending/${tag}`,
  TRENDING_GROUP: '/trending/group',
  ADMIN: '/admin',
  ADMIN_GROUPS: '/admin/groups',
  ADMIN_PERFORMANCE: '/admin/performance',
  ADMIN_DAG: '/admin/dag-visualizer',
  ADMIN_RESOLUTIONS: '/admin/resolutions',
  API_DOCS: '/api-docs',
  USER_BY_HANDLE: (handle: string) => `/u/${handle}`,
  USER_BY_ID: (id: string) => `/u/id/${id}`,
  ACTORS_BY_ID: (id: string) => `/actors/${id}`,
  ORGS_BY_ID: (id: string) => `/orgs/${id}`,
  OFFLINE: '/~offline',
} as const;

export const SELECTORS = {
  LOGIN_BUTTON:
    'button:has-text("Log in"), button:has-text("Login"), button:has-text("Connect Wallet"), button:has-text("Connect")',
  USER_MENU: '[data-testid="user-menu"]',
  NAV_LINK: 'nav a, [role="navigation"] a',
  BOTTOM_NAV: '[data-testid="bottom-nav"], nav.fixed.bottom-0',
  POST_CARD: '[data-testid="post-card"], article, .post-card',
  SEARCH_INPUT: 'input[type="search"], input[placeholder*="Search"]',
  FOLLOW_BUTTON: 'button:has-text("Follow")',
  MESSAGE_BUTTON: 'button:has-text("Message")',
  EDIT_PROFILE_BUTTON: 'button:has-text("Edit")',
  SAVE_BUTTON: 'button:has-text("Save")',
  CHAT_INPUT:
    'textarea[placeholder*="message" i], input[placeholder*="message" i]',
  SEND_BUTTON: 'button[aria-label*="send" i], button:has-text("Send")',
  MODAL: '[role="dialog"], .modal',
  BUY_POINTS_BUTTON:
    'button:has-text("Buy Points"), button:has-text("Buy"), button:has-text("Add Funds")',
  LIKE_BUTTON: 'button:has(svg.lucide-heart), button[aria-label*="like" i]',
  COMMENT_BUTTON:
    'button:has(svg.lucide-message-circle), button[aria-label*="comment" i]',
  SHARE_BUTTON: 'button:has(svg.lucide-share), button[aria-label*="share" i]',
  LONG_BUTTON:
    'button:has-text("Long"), button:has-text("Buy"), button:has-text("LONG")',
  SHORT_BUTTON:
    'button:has-text("Short"), button:has-text("Sell"), button:has-text("SHORT")',
  YES_BUTTON: 'button:has-text("YES"), button:has-text("Yes")',
  NO_BUTTON: 'button:has-text("NO"), button:has-text("No")',
  QUANTITY_INPUT:
    'input[placeholder*="amount" i], input[placeholder*="size" i], input[type="number"]',
  WATCHLIST_STAR:
    'button[aria-label*="watchlist" i], button[aria-label*="favorite" i], button:has(svg.lucide-star)',
  DAILY_CLAIM_BUTTON:
    'button:has-text("Claim"), button:has-text("Daily"), button:has-text("Collect")',
  PAGINATION_NEXT: 'button:has-text("Next"), button[aria-label*="next" i]',
  PAGINATION_PREV:
    'button:has-text("Previous"), button:has-text("Prev"), button[aria-label*="previous" i]',
  CREATE_AGENT_BUTTON:
    'button:has-text("Create Agent"), button:has-text("New Agent"), a:has-text("Create")',
} as const;

export const VIEWPORTS = {
  MOBILE_SMALL: { width: 320, height: 568 },
  MOBILE: { width: 375, height: 667 },
  TABLET: { width: 768, height: 1024 },
  DESKTOP: { width: 1280, height: 800 },
  DESKTOP_LARGE: { width: 1920, height: 1080 },
} as const;

export const TIMEOUTS = {
  SHORT: 3000,
  MEDIUM: 10000,
  LONG: 30000,
  EXTRA_LONG: 60000,
} as const;

export const SEED_PHRASE =
  'test test test test test test test test test test test junk';

export const DEFAULT_ANVIL_WALLET = {
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  seedPhrase: SEED_PHRASE,
  password: 'Tester@1234',
} as const;

/**
 * Repository Layer - Database Access
 *
 * Clear Domain Separation:
 *
 * 1. **Characters** (user_characters table)
 *    - User-created character definitions/templates
 *    - Marketplace items (public/private characters)
 *    - Repository: userCharactersRepository
 *
 * 2. **Agents** (agents table - ElizaOS framework)
 *    - Running agent instances (DO NOT MODIFY - framework dependency)
 *    - Created when characters are deployed
 *    - Repository: agentsRepository
 *
 * 3. **Deployments** (containers table)
 *    - Infrastructure for running agents (ECS/Docker)
 *    - Links characters to deployed agent instances
 *    - Repository: containersRepository
 *
 * 4. **ElizaOS Tables** (rooms, memories, participants, etc.)
 *    - Framework-managed conversation data
 *    - DO NOT MODIFY - ElizaOS manages these
 */

// ============================================
// Core Platform Repositories
// ============================================
export * from "./organizations";
export * from "./organization-invites";
export * from "./users";
export * from "./user-sessions";
export * from "./anonymous-sessions";
export * from "./api-keys";
export * from "./cli-auth-sessions";
export * from "./credit-transactions";
export * from "./credit-packs";
export * from "./usage-records";
export * from "./usage-quotas";
export * from "./model-pricing";
export * from "./provider-health";

// ============================================
// Character Domain (User-created definitions)
// ============================================
export * from "./characters";

// ============================================
// Deployment Domain (Infrastructure)
// ============================================
export * from "./containers";
export * from "./eliza-room-characters";
export * from "./agent-events";

// ============================================
// Agent Domain (ElizaOS Runtime)
// DO NOT MODIFY - Framework dependency
// ============================================
export * from "./agents";

// ============================================
// Agent Subdomain (ElizaOS Tables)
// Direct database access to ElizaOS tables
// ============================================
export * from "./agents/rooms";
export * from "./agents/participants";
export * from "./agents/entities";
export * from "./agents/memories";

// ============================================
// Conversation Domain
// ============================================
export * from "./conversations";
export * from "./generations";

// ============================================
// App Domain
// ============================================
export * from "./apps";
export * from "./app-credit-balances";
export * from "./app-earnings";

// ============================================
// Referrals & Rewards
// ============================================
export * from "./referrals";

// ============================================
// User MCPs (Monetizable MCP Servers)
// ============================================
export * from "./user-mcps";

// ============================================
// Token Redemptions (elizaOS payouts)
// ============================================
export * from "./token-redemptions";

// ============================================
// Crypto Payments (CDP wallet payments)
// ============================================
export * from "./crypto-payments";

// ============================================
// Advertising Domain
// ============================================
export * from "./ad-accounts";
export * from "./ad-campaigns";
export * from "./ad-creatives";
export * from "./ad-transactions";
export * from "./seo-artifacts";
export * from "./seo-provider-calls";
export * from "./seo-requests";

// ============================================
// Discord Domain (Bot Automation)
// ============================================
export * from "./discord-guilds";
export * from "./discord-channels";
export * from "./discord-connections";
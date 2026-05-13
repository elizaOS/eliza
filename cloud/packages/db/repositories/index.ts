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
 * 2. **Agents** (agents table - elizaOS framework)
 *    - Running agent instances (DO NOT MODIFY - framework dependency)
 *    - Created when characters are deployed
 *    - Repository: agentsRepository
 *
 * 3. **Deployments** (containers table)
 *    - Infrastructure for running agents (ECS/Docker)
 *    - Links characters to deployed agent instances
 *    - Repository: containersRepository
 *
 * 4. **elizaOS Tables** (rooms, memories, participants, etc.)
 *    - Framework-managed conversation data
 *    - DO NOT MODIFY - elizaOS manages these
 */

// ============================================
// Advertising Domain
// ============================================
export * from "./ad-accounts";
export * from "./ad-campaigns";
export * from "./ad-creatives";
export * from "./ad-transactions";
export * from "./affiliates";
export * from "./agent-billing";
export * from "./agent-events";
// ============================================
// Eliza Cloud Sandboxes
// ============================================
export * from "./agent-pairing-tokens";
export * from "./agent-sandboxes";
// ============================================
// Agent Domain (elizaOS Runtime)
// DO NOT MODIFY - Framework dependency
// ============================================
export * from "./agents";
export * from "./agents/entities";
export * from "./agents/memories";
export * from "./agents/participants";
// ============================================
// Agent Subdomain (elizaOS Tables)
// Direct database access to elizaOS tables
// ============================================
export * from "./agents/rooms";
export * from "./ai-billing-records";
export * from "./ai-pricing";
export * from "./analytics-alert-events";
export * from "./anonymous-sessions";
export * from "./api-keys";
export * from "./app-credit-balances";
export * from "./app-databases";
export * from "./app-earnings";
// ============================================
// App Domain
// ============================================
export * from "./apps";
// ============================================
// Character Domain (User-created definitions)
// ============================================
export * from "./characters";
export * from "./cli-auth-sessions";
export * from "./container-billing";
// ============================================
// Deployment Domain (Infrastructure)
// ============================================
export * from "./containers";
// ============================================
// Conversation Domain
// ============================================
export * from "./conversations";
export * from "./credit-packs";
export * from "./credit-transactions";
// ============================================
// Crypto Payments (CDP wallet payments)
// ============================================
export * from "./crypto-payments";
export * from "./dashboard";
export * from "./discord-channels";
export * from "./discord-connections";
// ============================================
// Discord Domain (Bot Automation)
// ============================================
export * from "./discord-guilds";
export * from "./docker-nodes";
export * from "./eliza-room-characters";
export * from "./generations";
// ============================================
// Background Jobs
// ============================================
export * from "./jobs";
export * from "./model-pricing";
// ============================================
// Core Platform Repositories
// ============================================
export * from "./org-rate-limit-overrides";
export * from "./org-storage-quota";
export * from "./organization-invites";
export * from "./organizations";
export * from "./provider-health";
// ============================================
// Referrals & Rewards
// ============================================
export * from "./referrals";
export * from "./seo-artifacts";
export * from "./seo-provider-calls";
export * from "./seo-requests";
export * from "./service-pricing";
// ============================================
// Token Redemptions (elizaOS payouts)
// ============================================
export * from "./token-redemptions";
export * from "./usage-quotas";
export * from "./usage-records";
// ============================================
// User MCPs (Monetizable MCP Servers)
// ============================================
export * from "./user-mcps";
export * from "./user-sessions";
export * from "./user-voices";
export * from "./users";
export * from "./vendor-connections";
export * from "./voice-imprints";

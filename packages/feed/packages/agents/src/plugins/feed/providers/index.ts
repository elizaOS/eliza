/**
 * Feed Plugin Providers
 * Export all providers
 */

export { agentWalletProvider } from "./agent-wallet";
export { dashboardProvider } from "./dashboard";
export { entityMentionsProvider } from "./entity-mentions";
export { goalsProvider } from "./goals";
// New context providers
export { headlinesProvider } from "./headlines";
export { marketMoversProvider } from "./market-movers";
export { marketsProvider } from "./markets";
export { messagesProvider, notificationsProvider } from "./messaging";
// NPC-specific provider for game awareness
export { getNpcGameContext, npcGameContextProvider } from "./npc-game-context";
export { portfolioProvider } from "./portfolio";
export { feedProvider, trendingProvider } from "./social";
export {
  livePlayerRosterProvider,
  recentRelevantGroupContextProvider,
  sharedChatFactsProvider,
} from "./social-context";
export { trendingTopicsProvider } from "./trending-topics";
export { userProfileProvider } from "./user-profile";
export { userWalletProvider } from "./user-wallet";
export {
  addContact,
  addFact,
  addTradeReasoning,
  loadWorkingMemory,
  saveWorkingMemory,
  workingMemoryProvider,
} from "./working-memory";

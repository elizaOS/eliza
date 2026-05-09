import type { EventHandlerMap, IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { testSuites } from "./__tests__/e2e/index";
import { events } from "./events";
import { socialAlphaProvider } from "./providers/socialAlphaProvider";
import { communityInvestorRoutes } from "./routes";
import { CommunityInvestorService } from "./service";

export { socialAlphaProvider } from "./providers/socialAlphaProvider";
export * from "./types";

// AgentPanel interface defined locally for UI integration
export interface AgentPanel {
	name: string;
	path: string;
	component: string;
	icon?: string;
	public?: boolean;
}

/**
 * Social Alpha Plugin for ElizaOS.
 *
 * Tracks token recommendations ("shills") and criticisms ("FUD") made by
 * users in chat. Builds trust scores for each recommender based on whether
 * following their calls would have been profitable — accounting for:
 *
 *   - Buy calls that mooned vs dumped
 *   - Sell/FUD calls on tokens that were scams (good call) vs tokens that rallied (bad call)
 *   - Conviction level, recency, and consistency
 *
 * Exposes a **Social Alpha Provider** that injects trust data (win rate,
 * rank, P&L history) into the agent's context so it can weigh advice
 * from different users.
 */
export const socialAlphaPlugin: Plugin = {
	name: "social-alpha",
	description:
		"Tracks token shills and FUD, builds trust scores based on P&L outcomes, and provides a Social Alpha Provider with win rate, rank, and recommender analytics.",
	config: {
		BIRDEYE_API_KEY: "",
		DEXSCREENER_API_KEY: "",
		HELIUS_API_KEY: "",
		PROCESS_TRADE_DECISION_INTERVAL_HOURS: "1",
		METRIC_REFRESH_INTERVAL_HOURS: "24",
		USER_TRADE_COOLDOWN_HOURS: "12",
		SCAM_PENALTY: "-100",
		SCAM_CORRECT_CALL_BONUS: "100",
		MAX_RECOMMENDATIONS_IN_PROFILE: "50",
	},
	async init(_config: Record<string, string>, runtime?: IAgentRuntime) {
		logger.info("[SocialAlpha] Plugin initializing...");
		if (runtime) {
			logger.info(`[SocialAlpha] Initialized for agent: ${runtime.agentId}`);
		}
	},
	services: [CommunityInvestorService],
	providers: [socialAlphaProvider],
	routes: communityInvestorRoutes,
	events: events as EventHandlerMap,
	tests: testSuites,
};

export const panels: AgentPanel[] = [
	{
		name: "Social Alpha",
		path: "display",
		component: "LeaderboardPanelPage",
		icon: "UsersRound",
		public: true,
	},
];

export default socialAlphaPlugin;

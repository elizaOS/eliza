import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { events } from "./events";
import { socialAlphaProvider } from "./providers/socialAlphaProvider";
import { communityInvestorRoutes } from "./routes";
import { CommunityInvestorService } from "./service";

export { socialAlphaProvider } from "./providers/socialAlphaProvider";
export * from "./types";

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
	name: "@elizaos/plugin-social-alpha",
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
	events: events as unknown as Plugin["events"],
	views: [
		{
			id: "social-alpha",
			label: "Social Alpha",
			description:
				"Trust leaderboard for token calls. Requires an agent wallet.",
			icon: "UsersRound",
			path: "/social-alpha",
			modalities: ["gui", "xr", "tui"],
			bundlePath: "dist/views/bundle.js",
			componentExport: "SocialAlphaView",
			tags: ["finance", "crypto", "social", "trust", "leaderboard"],
			visibleInManager: true,
			desktopTabEnabled: true,
		},
	],
	tests: [],
	async dispose(runtime) {
		await runtime
			.getService<CommunityInvestorService>(
				CommunityInvestorService.serviceType,
			)
			?.stop();
	},
};

export default socialAlphaPlugin;

// The GUI/XR data wrapper (`SocialAlphaView`) reaches the view bundle through
// `social-alpha-view-bundle.ts`; it is intentionally NOT re-exported here, since
// it imports the `@elizaos/ui` client barrel (browser-only) and the plugin's
// runtime export surface stays free of it. The presentational spatial component
// and its snapshot types are browser-safe and exported for terminal hosts.
export {
	EMPTY_SOCIAL_ALPHA_SNAPSHOT,
	type LeaderRow,
	type SocialAlphaSnapshot,
	SocialAlphaSpatialView,
	type SocialAlphaViewState,
} from "./frontend/SocialAlphaSpatialView";
export {
	registerSocialAlphaTerminalView,
	setSocialAlphaTerminalSnapshot,
} from "./register-terminal-view";

// Side-effect: in a terminal host (Node agent, no DOM) this registers the
// Social Alpha terminal view. DOM-guarded so the terminal engine stays out of
// browser bundles.
import "./register.js";

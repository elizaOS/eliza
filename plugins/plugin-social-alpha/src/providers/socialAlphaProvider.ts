import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import type { CommunityInvestorService } from "../service";
import {
	type LeaderboardEntry,
	type Recommendation,
	ServiceType,
	TRUST_MARKETPLACE_COMPONENT_TYPE,
	type UserTrustProfile,
} from "../types";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";

/**
 * Compute summary stats for a set of recommendations.
 */
function computeRecommenderStats(recommendations: Recommendation[]): {
	totalCalls: number;
	buyCalls: number;
	sellCalls: number;
	profitableCalls: number;
	winRate: number;
	averageProfit: number;
	bestCall: { token: string; profit: number } | null;
	worstCall: { token: string; profit: number } | null;
	scamsCaught: number;
	rugsPromoted: number;
} {
	const totalCalls = recommendations.length;
	let buyCalls = 0;
	let sellCalls = 0;
	let profitableCalls = 0;
	let totalProfit = 0;
	let scamsCaught = 0;
	let rugsPromoted = 0;
	let bestCall: { token: string; profit: number } | null = null;
	let worstCall: { token: string; profit: number } | null = null;

	for (const rec of recommendations) {
		if (rec.recommendationType === "BUY") buyCalls++;
		else sellCalls++;

		if (!rec.metrics) continue;

		const profit =
			rec.metrics.potentialProfitPercent ?? rec.metrics.avoidedLossPercent ?? 0;
		totalProfit += profit;

		if (profit > 0) profitableCalls++;

		if (rec.metrics.isScamOrRug) {
			if (rec.recommendationType === "SELL") {
				scamsCaught++;
			} else {
				rugsPromoted++;
			}
		}

		const tokenLabel = rec.tokenTicker ?? rec.tokenAddress.slice(0, 8);
		if (!bestCall || profit > bestCall.profit) {
			bestCall = { token: tokenLabel, profit };
		}
		if (!worstCall || profit < worstCall.profit) {
			worstCall = { token: tokenLabel, profit };
		}
	}

	const evaluatedCalls = recommendations.filter((r) => r.metrics).length;
	const winRate = evaluatedCalls > 0 ? profitableCalls / evaluatedCalls : 0;
	const averageProfit = evaluatedCalls > 0 ? totalProfit / evaluatedCalls : 0;

	return {
		totalCalls,
		buyCalls,
		sellCalls,
		profitableCalls,
		winRate,
		averageProfit,
		bestCall,
		worstCall,
		scamsCaught,
		rugsPromoted,
	};
}

/**
 * Format a single leaderboard entry into readable text.
 */
function formatLeaderboardEntry(
	entry: LeaderboardEntry,
	detailed: boolean,
): string {
	const stats = computeRecommenderStats(entry.recommendations);
	const winPct = (stats.winRate * 100).toFixed(1);
	const avgProfitStr =
		stats.averageProfit >= 0
			? `+${stats.averageProfit.toFixed(1)}%`
			: `${stats.averageProfit.toFixed(1)}%`;

	let line = `#${entry.rank ?? "?"} ${entry.username ?? entry.userId.slice(0, 8)} — Trust: ${entry.trustScore.toFixed(1)} | Win Rate: ${winPct}% | Avg P&L: ${avgProfitStr} | Calls: ${stats.totalCalls}`;

	if (detailed) {
		const parts: string[] = [];
		parts.push(`  Buys: ${stats.buyCalls}, Sells/FUD: ${stats.sellCalls}`);
		parts.push(`  Profitable: ${stats.profitableCalls}/${stats.totalCalls}`);
		if (stats.scamsCaught > 0)
			parts.push(`  Scams correctly called out: ${stats.scamsCaught}`);
		if (stats.rugsPromoted > 0)
			parts.push(`  Rugs promoted (penalty): ${stats.rugsPromoted}`);
		if (stats.bestCall)
			parts.push(
				`  Best call: ${stats.bestCall.token} (${stats.bestCall.profit >= 0 ? "+" : ""}${stats.bestCall.profit.toFixed(1)}%)`,
			);
		if (stats.worstCall)
			parts.push(
				`  Worst call: ${stats.worstCall.token} (${stats.worstCall.profit >= 0 ? "+" : ""}${stats.worstCall.profit.toFixed(1)}%)`,
			);
		line += `\n${parts.join("\n")}`;
	}

	return line;
}

/**
 * socialAlphaProvider — Injects trust-score intelligence into agent context.
 *
 * When the agent processes a message, this provider:
 *   1. Looks up the sender's trust profile (if they have one).
 *   2. Provides a compact leaderboard summary (top callers + bottom callers).
 *   3. Surfaces win rate, rank, avg P&L, scam detection stats.
 *
 * The agent can use this data to weigh recommendations, respond with trust
 * context, or decline to act on low-trust callers.
 */
export const socialAlphaProvider: Provider = {
	name: "socialAlpha",
	description:
		"Provides trust scores, win rates, and performance rankings for token recommenders (shill/FUD trackers). " +
		"Shows whether a person's past calls would have made or lost money.",
	descriptionCompressed:
		"provide trust score, win rate, performance ranking token recommender (shill/fud tracker) show whether person past call make lost money",

	dynamic: true,
	contexts: ["finance", "crypto", "social_posting"],
	contextGate: { anyOf: ["finance", "crypto", "social_posting"] },
	cacheStable: false,
	cacheScope: "turn",
	relevanceKeywords: [
		"socialalpha",
		"socialalphaprovider",
		"plugin",
		"social",
		"alpha",
		"status",
		"state",
		"context",
		"info",
		"details",
		"chat",
		"conversation",
		"agent",
		"room",
	],
	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		const __providerKeywords = [
			"socialalpha",
			"socialalphaprovider",
			"plugin",
			"social",
			"alpha",
			"status",
			"state",
			"context",
			"info",
			"details",
			"chat",
			"conversation",
			"agent",
			"room",
		];
		const __providerRegex = new RegExp(
			`\\b(${__providerKeywords.join("|")})\\b`,
			"i",
		);
		const __recentMessages = _state?.recentMessagesData || [];
		const __isRelevant =
			validateActionKeywords(message, __recentMessages, __providerKeywords) ||
			validateActionRegex(message, __recentMessages, __providerRegex);
		if (!__isRelevant) {
			return { text: "" };
		}

		try {
			const service = runtime.getService<CommunityInvestorService>(
				ServiceType.COMMUNITY_INVESTOR,
			);

			if (!service) {
				return {
					text: "",
					values: {},
				};
			}

			const senderId = message.entityId;
			const sections: string[] = [];

			// --- Sender's Trust Profile ---
			let senderProfile: UserTrustProfile | null = null;
			try {
				const component = await runtime.getComponent(
					senderId,
					TRUST_MARKETPLACE_COMPONENT_TYPE,
					service.componentWorldId,
					runtime.agentId,
				);
				if (component?.data) {
					senderProfile = component.data as UserTrustProfile;
				}
			} catch (err) {
				logger.debug(
					`[socialAlphaProvider] No profile for sender ${senderId}: ${err}`,
				);
			}

			if (senderProfile && senderProfile.recommendations.length > 0) {
				const stats = computeRecommenderStats(senderProfile.recommendations);
				const winPct = (stats.winRate * 100).toFixed(1);
				const avgProfitStr =
					stats.averageProfit >= 0
						? `+${stats.averageProfit.toFixed(1)}%`
						: `${stats.averageProfit.toFixed(1)}%`;

				sections.push(
					`[Current Speaker's Trust Profile]\n` +
						`Trust Score: ${senderProfile.trustScore.toFixed(1)}/100\n` +
						`Win Rate: ${winPct}% (${stats.profitableCalls}/${stats.totalCalls} calls)\n` +
						`Avg P&L: ${avgProfitStr}\n` +
						`Buy calls: ${stats.buyCalls} | Sell/FUD calls: ${stats.sellCalls}\n` +
						(stats.scamsCaught > 0
							? `Scams correctly identified: ${stats.scamsCaught}\n`
							: "") +
						(stats.rugsPromoted > 0
							? `Rugs promoted (trust penalty): ${stats.rugsPromoted}\n`
							: "") +
						(stats.bestCall
							? `Best call: ${stats.bestCall.token} (${stats.bestCall.profit >= 0 ? "+" : ""}${stats.bestCall.profit.toFixed(1)}%)`
							: ""),
				);
			}

			// --- Leaderboard Summary ---
			let leaderboard: LeaderboardEntry[] = [];
			try {
				leaderboard = await service.getLeaderboardData(runtime);
			} catch (err) {
				logger.debug(
					`[socialAlphaProvider] Error fetching leaderboard: ${err}`,
				);
			}

			if (leaderboard.length > 0) {
				const TOP_N = 5;
				const BOTTOM_N = 3;

				const top = leaderboard.slice(0, TOP_N);
				const bottom =
					leaderboard.length > TOP_N ? leaderboard.slice(-BOTTOM_N) : [];

				const topLines = top.map((e) => formatLeaderboardEntry(e, false));

				let leaderboardText = `[Social Alpha Leaderboard — ${leaderboard.length} tracked recommenders]\n`;
				leaderboardText += `Top Callers:\n${topLines.join("\n")}`;

				if (bottom.length > 0) {
					const bottomLines = bottom.map((e) =>
						formatLeaderboardEntry(e, false),
					);
					leaderboardText += `\n\nLowest Trust:\n${bottomLines.join("\n")}`;
				}

				// Find sender's rank
				if (senderProfile) {
					const senderEntry = leaderboard.find((e) => e.userId === senderId);
					if (senderEntry?.rank) {
						leaderboardText += `\n\nCurrent speaker's rank: #${senderEntry.rank} of ${leaderboard.length}`;
					}
				}

				sections.push(leaderboardText);
			}

			if (sections.length === 0) {
				return { text: "", values: {} };
			}

			const fullText = sections.join("\n\n");

			// Build structured values for programmatic access
			const values: Record<string, string> = {};
			if (senderProfile) {
				values.senderTrustScore = senderProfile.trustScore.toFixed(1);
				values.senderTotalCalls = String(senderProfile.recommendations.length);
				const senderStats = computeRecommenderStats(
					senderProfile.recommendations,
				);
				values.senderWinRate = (senderStats.winRate * 100).toFixed(1);
				values.senderAvgProfit = senderStats.averageProfit.toFixed(1);
			}
			values.trackedRecommenders = String(leaderboard.length);

			return {
				text: fullText,
				values,
			};
		} catch (error) {
			logger.error(
				"[socialAlphaProvider] Error generating provider data:",
				error,
			);
			return { text: "", values: {} };
		}
	},
};

export default socialAlphaProvider;

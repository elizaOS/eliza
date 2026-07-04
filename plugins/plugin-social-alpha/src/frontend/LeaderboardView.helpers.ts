import type { UUID } from "@elizaos/core";
import { client } from "@elizaos/ui/api";
import type {
	Conviction,
	LeaderboardEntry,
	Recommendation,
	RecommendationMetric,
	SupportedChain,
} from "../types";

function jsonRow(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("Leaderboard row is not a JSON object");
	}
	return value as Record<string, unknown>;
}

function parseRecommendationRow(
	record: Record<string, unknown>,
): Recommendation {
	return {
		id: record.id as UUID,
		userId: record.userId as UUID,
		messageId: record.messageId as UUID,
		timestamp:
			typeof record.timestamp === "number"
				? record.timestamp
				: Number(record.timestamp),
		tokenTicker:
			typeof record.tokenTicker === "string" ? record.tokenTicker : undefined,
		tokenAddress:
			typeof record.tokenAddress === "string"
				? record.tokenAddress
				: String(record.tokenAddress ?? ""),
		chain: record.chain as SupportedChain,
		recommendationType: record.recommendationType as "BUY" | "SELL",
		conviction: record.conviction as Conviction,
		rawMessageQuote:
			typeof record.rawMessageQuote === "string"
				? record.rawMessageQuote
				: String(record.rawMessageQuote ?? ""),
		priceAtRecommendation:
			typeof record.priceAtRecommendation === "number"
				? record.priceAtRecommendation
				: undefined,
		metrics: record.metrics as RecommendationMetric | undefined,
		processedForTradeDecision:
			typeof record.processedForTradeDecision === "boolean"
				? record.processedForTradeDecision
				: undefined,
	};
}

/** True when the agent has at least one wallet address configured. */
export async function hasWalletConfigured(): Promise<boolean> {
	try {
		const addresses = await client.getWalletAddresses();
		return Boolean(addresses?.evmAddress || addresses?.solanaAddress);
	} catch {
		// error-policy:J4 wallet gate degrades closed — an unreachable API reads as
		// "not configured" and shows the wallet-required state (never a false-open)
		return false;
	}
}

/** Fetch + rank the leaderboard via the plugin's route. */
export async function fetchLeaderboardData(): Promise<LeaderboardEntry[]> {
	const data = await client.fetch<{ message?: string; data?: unknown }>(
		"/api/social-alpha/leaderboard",
	);
	const rows = data.data;
	if (!Array.isArray(rows)) {
		throw new Error(
			data.message ?? "Leaderboard API response did not include a data array",
		);
	}

	const transformed: LeaderboardEntry[] = rows.map((entryRaw) => {
		const entry = jsonRow(entryRaw);
		const recs = Array.isArray(entry.recommendations)
			? entry.recommendations
			: [];
		return {
			userId: entry.userId as UUID,
			username: typeof entry.username === "string" ? entry.username : undefined,
			trustScore: typeof entry.trustScore === "number" ? entry.trustScore : 0,
			recommendations: recs.map((rec) => parseRecommendationRow(jsonRow(rec))),
		};
	});

	return transformed
		.sort((a, b) => b.trustScore - a.trustScore)
		.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

import type { UUID } from "@elizaos/core";
import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
// Import types from the central types.ts file
import type {
	Conviction, // Import Conviction enum
	LeaderboardEntry,
	Recommendation,
	RecommendationMetric,
	SupportedChain,
} from "../types.ts"; // Adjusted path to central types.ts
import { LeaderboardTable } from "./LeaderboardTable.tsx";
import Loader from "./loader.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card.tsx";

const queryClient = new QueryClient();

// Function to fetch real leaderboard data from the backend
async function fetchLeaderboardData(): Promise<LeaderboardEntry[]> {
	// Read agentId from window object injected by the server
	const agentId = (window as any).elizaAgentId;

	let apiUrl = "/api/plugins/community-investor/leaderboard"; // Default path

	if (agentId) {
		apiUrl = `/api/agents/${agentId}/plugins/community-investor/leaderboard`;
		console.log(`[Leaderboard] Using agent-specific API path: ${apiUrl}`);
	} else {
		console.warn(
			"[Leaderboard] window.elizaAgentId not found. Attempting global plugin path. This might fail if the route is not public or the server setup requires an agent context.",
		);
	}

	const response = await fetch(apiUrl);
	if (!response.ok) {
		const errorData = await response
			.json()
			.catch(() => ({ message: "Failed to parse error response" }));
		throw new Error(
			errorData.message ||
				`Network response was not ok: ${response.statusText}`,
		);
	}
	const data = await response.json();

	// Transform the data to ensure proper typing
	const transformedData: LeaderboardEntry[] = (data.data as any[]).map(
		(entry: any) => ({
			userId: entry.userId as UUID,
			username: entry.username,
			trustScore: entry.trustScore,
			recommendations: (entry.recommendations || []).map(
				(rec: any) =>
					({
						id: rec.id as UUID,
						userId: rec.userId as UUID,
						messageId: rec.messageId as UUID,
						timestamp: rec.timestamp,
						tokenTicker: rec.tokenTicker,
						tokenAddress: rec.tokenAddress,
						chain: rec.chain as SupportedChain,
						recommendationType: rec.recommendationType as "BUY" | "SELL",
						conviction: rec.conviction as Conviction, // Changed type assertion
						rawMessageQuote: rec.rawMessageQuote,
						priceAtRecommendation: rec.priceAtRecommendation,
						metrics: rec.metrics as RecommendationMetric,
						processedForTradeDecision: rec.processedForTradeDecision,
					}) as Recommendation,
			),
		}),
	);

	// Sort and rank the data
	return transformedData
		.sort((a, b) => b.trustScore - a.trustScore)
		.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function LeaderboardPanelPage() {
	const {
		data: leaderboardData,
		isLoading,
		error,
	} = useQuery<LeaderboardEntry[], Error>({
		queryKey: ["leaderboardData"],
		queryFn: fetchLeaderboardData,
		refetchInterval: 15000, // Refetch every 15 seconds to keep the leaderboard fresh
	});

	return (
		<div className="min-h-screen flex flex-col gap-4 py-4 bg-background text-foreground">
			<div className="container mx-auto px-4 flex-grow">
				<header className="py-6 text-center">
					<h1 className="text-5xl font-bold tracking-tight bg-gradient-to-r from-primary via-orange-400 to-secondary text-transparent bg-clip-text">
						Alpha Leaderboard
					</h1>
				</header>

				<main className="flex flex-col gap-8">
					<Card className="shadow-xl border-border/40">
						<CardHeader className="border-b border-border/30">
							<CardTitle className="text-2xl text-center">
								Top Callers
							</CardTitle>
						</CardHeader>
						<CardContent className="pt-6">
							{isLoading && <Loader />}
							{error && (
								<div className="text-red-500 p-4 border border-destructive/50 bg-destructive/10 rounded-md text-center">
									<p className="font-semibold">Error Fetching Leaderboard:</p>
									<p className="text-sm">{error.message}</p>
									<p className="text-xs mt-2">
										Please ensure the backend service is running and the API
										endpoint is correct.
									</p>
								</div>
							)}
							{leaderboardData && leaderboardData.length > 0 && (
								<LeaderboardTable data={leaderboardData} />
							)}
							{leaderboardData &&
								leaderboardData.length === 0 &&
								!isLoading &&
								!error && (
									<p className="text-muted-foreground text-center py-10 text-lg">
										No leaderboard data available yet. Be the first to make a
										recommendation!
									</p>
								)}
						</CardContent>
					</Card>
				</main>
			</div>
			<footer className="text-center py-4 text-xs text-muted-foreground border-t border-border/20 mt-auto">
				Powered by ElizaOS Social Alpha Plugin
			</footer>
		</div>
	);
}

export default LeaderboardPanelPage;

const rootElement = document.getElementById("root");
if (rootElement) {
	createRoot(rootElement).render(
		<React.StrictMode>
			<QueryClientProvider client={queryClient}>
				<LeaderboardPanelPage />
			</QueryClientProvider>
		</React.StrictMode>,
	);
}

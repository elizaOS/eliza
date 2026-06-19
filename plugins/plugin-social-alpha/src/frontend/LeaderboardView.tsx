import { EmptyState } from "@elizaos/ui/components";
import { Spinner } from "@elizaos/ui/components/ui/spinner";
import { UsersRound, Wallet } from "lucide-react";
import { useEffect, useState } from "react";
import type { LeaderboardEntry } from "../types";
import { LeaderboardTable } from "./LeaderboardTable";
import {
	fetchLeaderboardData,
	hasWalletConfigured,
} from "./LeaderboardView.helpers";

const REFRESH_INTERVAL_MS = 15_000;

export function SocialAlphaView() {
	const [walletReady, setWalletReady] = useState<boolean | null>(null);
	const [leaderboardData, setLeaderboardData] = useState<
		LeaderboardEntry[] | null
	>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void hasWalletConfigured().then((ready) => {
			if (!cancelled) setWalletReady(ready);
		});
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!walletReady) return;
		let cancelled = false;

		const load = async () => {
			try {
				const data = await fetchLeaderboardData();
				if (!cancelled) {
					setLeaderboardData(data);
					setError(null);
				}
			} catch (err) {
				if (!cancelled) {
					setError(err instanceof Error ? err.message : String(err));
				}
			}
		};

		void load();
		const interval = setInterval(load, REFRESH_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [walletReady]);

	if (walletReady === null) {
		return (
			<div className="flex w-full justify-center py-16">
				<Spinner />
			</div>
		);
	}

	if (!walletReady) {
		return (
			<div className="flex min-h-full w-full items-center justify-center py-16">
				<EmptyState
					icon={<Wallet />}
					title="Wallet required"
					description="Social Alpha tracks token calls against on-chain outcomes. Configure the agent wallet to enable it."
				/>
			</div>
		);
	}

	const leader = leaderboardData?.[0];

	return (
		<div className="flex min-h-full flex-col bg-background pt-4 pb-24 text-foreground">
			<div className="container mx-auto flex-grow px-4">
				<header className="flex items-center gap-2 py-6">
					<UsersRound className="h-5 w-5 text-muted-foreground" />
					<h1 className="font-semibold text-foreground text-xl tracking-tight">
						Alpha Leaderboard
					</h1>
				</header>

				<main className="flex flex-col">
					{leader?.username && (
						<p className="pb-3 text-muted-foreground text-sm">
							Top Callers · leading: {leader.username} (
							{leader.trustScore.toFixed(2)})
						</p>
					)}
					<div className="border-border/30 border-t pt-2">
						{!leaderboardData && !error && (
							<div className="flex w-full justify-center py-12">
								<Spinner />
							</div>
						)}
						{error && (
							<div className="py-6 text-center text-red-500">
								<p className="font-semibold">Error Fetching Leaderboard:</p>
								<p className="text-sm">{error}</p>
							</div>
						)}
						{leaderboardData && leaderboardData.length > 0 && (
							<LeaderboardTable data={leaderboardData} />
						)}
						{leaderboardData && leaderboardData.length === 0 && !error && (
							<p className="py-10 text-center text-lg text-muted-foreground">
								No leaderboard data available yet. Be the first to make a
								recommendation!
							</p>
						)}
					</div>
				</main>
			</div>
		</div>
	);
}

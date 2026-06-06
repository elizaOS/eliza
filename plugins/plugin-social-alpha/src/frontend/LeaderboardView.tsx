import {
	Card,
	CardContent,
	CardHeader,
	CardTitle,
	EmptyState,
} from "@elizaos/ui/components";
import { Spinner } from "@elizaos/ui/components/ui/spinner";
import { Wallet } from "lucide-react";
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

	return (
		<div className="flex min-h-full flex-col gap-4 bg-background pt-4 pb-24 text-foreground">
			<div className="container mx-auto flex-grow px-4">
				<header className="py-6 text-center">
					<h1 className="bg-gradient-to-r from-primary via-orange-400 to-secondary bg-clip-text font-bold text-5xl text-transparent tracking-tight">
						Alpha Leaderboard
					</h1>
				</header>

				<main className="flex flex-col gap-8">
					<Card className="border-border/40 shadow-xl">
						<CardHeader className="border-border/30 border-b">
							<CardTitle className="text-center text-2xl">
								Top Callers
							</CardTitle>
						</CardHeader>
						<CardContent className="pt-6">
							{!leaderboardData && !error && (
								<div className="flex w-full justify-center py-12">
									<Spinner />
								</div>
							)}
							{error && (
								<div className="rounded-md border border-destructive/50 bg-destructive/10 p-4 text-center text-red-500">
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
						</CardContent>
					</Card>
				</main>
			</div>
		</div>
	);
}

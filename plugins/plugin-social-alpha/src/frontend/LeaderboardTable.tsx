import {
	AlertTriangle,
	Bot,
	CheckCircle,
	ChevronDown,
	ChevronUp,
	Sparkles,
	TrendingDown,
	TrendingUp,
} from "lucide-react";
import React from "react";
import type { LeaderboardEntry, Recommendation } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "./ui/table";
import { cn } from "./utils";

interface RecommendationDetailsProps {
	recommendations: Recommendation[];
	username: string;
}

const RecommendationDetails: React.FC<RecommendationDetailsProps> = ({
	recommendations,
	username,
}) => {
	if (!recommendations || recommendations.length === 0) {
		return (
			<div className="p-6 text-center bg-muted/20">
				<p className="text-sm text-muted-foreground">
					<Bot className="inline-block w-5 h-5 mr-2 text-primary/70" />
					No specific recommendations recorded for {username} yet.
				</p>
			</div>
		);
	}

	return (
		<div className="py-3 px-2 sm:px-4 bg-muted/20 shadow-inner">
			<h4 className="text-lg font-semibold mb-4 text-center text-foreground/90 border-b border-border/30 pb-2">
				<Sparkles className="inline-block w-5 h-5 mr-2 text-primary/80" />
				Recommendations by {username}
			</h4>
			<div className="space-y-4 max-h-[400px] overflow-y-auto custom-scrollbar p-1 pr-2">
				{recommendations.slice(0, 10).map(
					(
						rec, // Show max 10 recent for brevity
					) => (
						<Card
							key={rec.id}
							className="overflow-hidden shadow-lg bg-card hover:shadow-primary/20 transition-shadow duration-200 border-border/30"
						>
							<CardHeader className="pb-2 pt-4 px-4 bg-slate-50 dark:bg-slate-800/50 border-b border-border/20">
								<div className="flex justify-between items-start">
									<div className="flex-grow">
										<CardTitle className="text-base font-semibold text-primary flex items-center">
											{rec.recommendationType === "BUY" ? (
												<TrendingUp className="w-5 h-5 mr-2 text-green-500" />
											) : (
												<TrendingDown className="w-5 h-5 mr-2 text-red-500" />
											)}
											{rec.tokenTicker ||
												rec.tokenAddress.substring(0, 6) +
													"..." +
													rec.tokenAddress.substring(
														rec.tokenAddress.length - 4,
													)}
										</CardTitle>
										<Badge
											variant="outline"
											className="mt-1 text-xs font-mono tracking-wider"
										>
											{rec.chain} - {rec.tokenAddress}
										</Badge>
									</div>
									<Badge
										variant={
											rec.recommendationType === "BUY"
												? "success"
												: "destructive"
										}
										className="text-xs px-2 py-0.5 self-start"
									>
										{rec.recommendationType}
									</Badge>
								</div>
								<CardDescription className="text-xs text-muted-foreground pt-1.5">
									{new Date(rec.timestamp).toLocaleString()} | Conviction:
									<Badge
										variant="secondary"
										className="ml-1 text-xs font-normal px-1.5 py-0.5"
									>
										{rec.conviction}
									</Badge>
								</CardDescription>
							</CardHeader>
							<CardContent className="px-4 py-3 space-y-2 text-sm">
								<p className="italic border-l-2 border-primary/60 pl-3 py-1.5 bg-primary/10 rounded-r-md text-foreground/90 text-[13px]">
									&ldquo;{rec.rawMessageQuote}&rdquo;
								</p>
								{rec.priceAtRecommendation !== undefined &&
									rec.priceAtRecommendation !== null && (
										<p className="text-xs">
											Price at Rec:{" "}
											<span className="font-medium text-foreground/80">
												$
												{rec.priceAtRecommendation.toLocaleString(undefined, {
													minimumFractionDigits: 2,
													maximumFractionDigits: 6,
												})}
											</span>
										</p>
									)}
								{rec.metrics && (
									<div className="mt-2 pt-2.5 border-t border-border/30 text-xs space-y-1.5">
										<p className="font-medium text-foreground/80 flex items-center">
											<CheckCircle className="w-3.5 h-3.5 mr-1.5 text-blue-500" />
											Evaluation (as of{" "}
											{new Date(
												rec.metrics.evaluationTimestamp,
											).toLocaleDateString()}
											):
										</p>
										{rec.metrics.potentialProfitPercent !== undefined && (
											<p>
												Potential Profit:
												<span
													className={cn(
														"font-bold",
														rec.metrics.potentialProfitPercent >= 0
															? "text-green-500"
															: "text-red-500",
													)}
												>
													{rec.metrics.potentialProfitPercent.toFixed(1)}%
												</span>
											</p>
										)}
										{rec.metrics.avoidedLossPercent !== undefined && (
											<p>
												Avoided Loss:
												<span className={cn("font-bold text-green-500")}>
													{rec.metrics.avoidedLossPercent.toFixed(1)}%
												</span>
											</p>
										)}
										{rec.metrics.isScamOrRug && (
											<Badge
												variant="destructive"
												className="my-1 text-xs flex items-center w-fit"
											>
												<AlertTriangle className="w-3 h-3 mr-1" /> Flagged:
												Scam/Rug
											</Badge>
										)}
										{rec.metrics.notes && (
											<p className="text-muted-foreground text-[11px] italic">
												Notes: {rec.metrics.notes}
											</p>
										)}
									</div>
								)}
							</CardContent>
						</Card>
					),
				)}
			</div>
		</div>
	);
};

interface LeaderboardTableProps {
	data: LeaderboardEntry[];
}

export const LeaderboardTable: React.FC<LeaderboardTableProps> = ({ data }) => {
	const [expandedUser, setExpandedUser] = React.useState<string | null>(null);

	const toggleExpand = (userId: string) => {
		setExpandedUser(expandedUser === userId ? null : userId);
	};

	if (!data || data.length === 0) {
		return (
			<p className="text-center py-10 text-lg text-muted-foreground">
				<Bot className="inline-block w-6 h-6 mr-2 text-primary/70" />
				No leaderboard data available yet.
			</p>
		);
	}

	return (
		<Table className="min-w-full table-fixed">
			<TableHeader className="bg-muted/50 sticky top-0 z-10">
				<TableRow>
					<TableHead className="w-[70px] text-center font-semibold text-foreground/90 py-3">
						Rank
					</TableHead>
					<TableHead className="font-semibold text-foreground/90 py-3">
						Username
					</TableHead>
					<TableHead className="text-right w-[150px] font-semibold text-foreground/90 py-3">
						Trust Score
					</TableHead>
					<TableHead className="w-[150px] text-center font-semibold text-foreground/90 py-3">
						Actions
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.map((entry) => (
					<React.Fragment key={entry.userId}>
						<TableRow
							className={cn(
								"border-b border-border/20 hover:bg-muted/30 transition-colors",
								expandedUser === entry.userId.toString() &&
									"bg-primary/5 dark:bg-primary/10",
							)}
						>
							<TableCell className="font-bold text-2xl text-center text-primary/80 py-4">
								{entry.rank}
							</TableCell>
							<TableCell className="font-medium text-foreground/90 py-4">
								{entry.username || `${entry.userId.substring(0, 12)}...`}
							</TableCell>
							<TableCell
								className={cn(
									"text-right font-bold text-lg py-4",
									entry.trustScore > 50
										? "text-green-500"
										: entry.trustScore > 5
											? "text-green-600/80"
											: entry.trustScore < -50
												? "text-red-500"
												: entry.trustScore < -5
													? "text-red-600/80"
													: "text-foreground/70",
								)}
							>
								{entry.trustScore.toFixed(2)}
							</TableCell>
							<TableCell className="text-center py-4">
								<Button
									variant="ghost"
									size="sm"
									onClick={() => toggleExpand(entry.userId.toString())}
									className="h-8 px-3 text-xs hover:bg-primary/20 data-[state=open]:bg-primary/20"
									data-state={
										expandedUser === entry.userId.toString() ? "open" : "closed"
									}
								>
									{expandedUser === entry.userId.toString() ? (
										<>
											<ChevronUp className="w-4 h-4 mr-1.5" /> Hide Recs
										</>
									) : (
										<>
											<ChevronDown className="w-4 h-4 mr-1.5" /> View Recs
										</>
									)}
								</Button>
							</TableCell>
						</TableRow>
						{expandedUser === entry.userId.toString() && (
							<TableRow className="bg-background hover:bg-background">
								<TableCell colSpan={4} className="p-0 border-none">
									<RecommendationDetails
										recommendations={entry.recommendations}
										username={entry.username || entry.userId.toString()}
									/>
								</TableCell>
							</TableRow>
						)}
					</React.Fragment>
				))}
			</TableBody>
		</Table>
	);
};

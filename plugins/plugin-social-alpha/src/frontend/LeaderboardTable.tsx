import {
	Badge,
	Button,
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@elizaos/ui/components";
import { cn } from "@elizaos/ui/utils";
import {
	AlertTriangle,
	Bot,
	ChevronDown,
	ChevronUp,
	TrendingDown,
	TrendingUp,
} from "lucide-react";
import React from "react";
import type { LeaderboardEntry, Recommendation } from "../types";

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
			<div className="p-6 text-center">
				<p className="text-sm text-muted-foreground">
					<Bot className="mr-2 inline-block h-5 w-5 text-muted-foreground" />
					No specific recommendations recorded for {username} yet.
				</p>
			</div>
		);
	}

	return (
		<div className="px-2 py-3 sm:px-4">
			<h4 className="mb-4 pb-2 text-center font-semibold text-foreground/90 text-lg">
				Recommendations by {username}
			</h4>
			<div className="custom-scrollbar max-h-[400px] space-y-3 overflow-y-auto p-1 pr-2">
				{recommendations.slice(0, 10).map((rec) => (
					<div
						key={rec.id}
						className="border-border/30 border-b pb-3 last:border-b-0"
					>
						<div className="flex items-start justify-between">
							<div className="flex-grow">
								<div className="flex items-center font-semibold text-base text-foreground">
									{rec.recommendationType === "BUY" ? (
										<TrendingUp className="mr-2 h-5 w-5 text-foreground" />
									) : (
										<TrendingDown className="mr-2 h-5 w-5 text-destructive" />
									)}
									{rec.tokenTicker ||
										rec.tokenAddress.substring(0, 6) +
											"..." +
											rec.tokenAddress.substring(rec.tokenAddress.length - 4)}
								</div>
								<span className="mt-1 block font-mono text-muted-foreground text-xs tracking-wider">
									{rec.chain} · {rec.tokenAddress}
								</span>
							</div>
							<Badge
								variant="outline"
								className="self-start px-2 py-0.5 text-xs"
							>
								{rec.recommendationType}
							</Badge>
						</div>
						<p className="pt-1.5 text-muted-foreground text-xs">
							{new Date(rec.timestamp).toLocaleString()} | Conviction:
							<Badge
								variant="secondary"
								className="ml-1 px-1.5 py-0.5 font-normal text-xs"
							>
								{rec.conviction}
							</Badge>
						</p>
						<div className="space-y-2 pt-2 text-sm">
							<p className="border-primary/60 border-l-2 py-1.5 pl-3 text-[13px] text-foreground/90 italic">
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
								<div className="mt-2 space-y-1.5 border-border/30 border-t pt-2.5 text-xs">
									<p className="flex items-center font-medium text-foreground/80">
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
														? "text-foreground"
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
											<span className={cn("font-bold text-foreground")}>
												{rec.metrics.avoidedLossPercent.toFixed(1)}%
											</span>
										</p>
									)}
									{rec.metrics.isScamOrRug && (
										<Badge
											variant="destructive"
											className="my-1 flex w-fit items-center text-xs"
										>
											<AlertTriangle className="mr-1 h-3 w-3" /> Flagged:
											Scam/Rug
										</Badge>
									)}
									{rec.metrics.notes && (
										<p className="text-[11px] text-muted-foreground italic">
											Notes: {rec.metrics.notes}
										</p>
									)}
								</div>
							)}
						</div>
					</div>
				))}
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
			<p className="py-10 text-center text-lg text-muted-foreground">
				<Bot className="mr-2 inline-block h-6 w-6 text-muted-foreground" />
				No leaderboard data available yet.
			</p>
		);
	}

	return (
		<Table className="min-w-full table-fixed">
			<TableHeader className="sticky top-0 z-10">
				<TableRow>
					<TableHead className="w-[70px] py-3 text-center font-semibold text-foreground/90">
						Rank
					</TableHead>
					<TableHead className="py-3 font-semibold text-foreground/90">
						Username
					</TableHead>
					<TableHead className="w-[150px] py-3 text-right font-semibold text-foreground/90">
						Trust Score
					</TableHead>
					<TableHead className="w-[150px] py-3 text-center font-semibold text-foreground/90">
						Actions
					</TableHead>
				</TableRow>
			</TableHeader>
			<TableBody>
				{data.map((entry) => {
					const isTop = entry.rank === 1;
					const isNegative = entry.trustScore < 0;
					return (
						<React.Fragment key={entry.userId}>
							<TableRow
								className={cn(
									"border-border/20 border-b transition-colors hover:bg-muted/30",
									expandedUser === entry.userId.toString() && "bg-primary/5",
								)}
							>
								<TableCell className="py-4 text-center font-bold text-2xl text-foreground/80">
									{entry.rank}
								</TableCell>
								<TableCell className="py-4 font-medium text-foreground/90">
									{entry.username || `${entry.userId.substring(0, 12)}...`}
								</TableCell>
								<TableCell
									className={cn(
										"py-4 text-right font-bold text-lg",
										isNegative ? "text-red-500" : "text-foreground",
									)}
								>
									<span className="inline-flex items-center justify-end gap-2">
										<span
											className={cn(
												"h-1.5 w-1.5 rounded-full",
												isTop
													? "bg-primary"
													: isNegative
														? "bg-red-500"
														: "bg-muted-foreground/40",
											)}
											aria-hidden="true"
										/>
										{entry.trustScore.toFixed(2)}
									</span>
								</TableCell>
								<TableCell className="py-4 text-center">
									<Button
										variant="ghost"
										size="sm"
										onClick={() => toggleExpand(entry.userId.toString())}
										className="h-8 px-3 text-xs hover:bg-primary/20 data-[state=open]:bg-primary/20"
										data-state={
											expandedUser === entry.userId.toString()
												? "open"
												: "closed"
										}
									>
										{expandedUser === entry.userId.toString() ? (
											<>
												<ChevronUp className="mr-1.5 h-4 w-4" /> Hide Recs
											</>
										) : (
											<>
												<ChevronDown className="mr-1.5 h-4 w-4" /> View Recs
											</>
										)}
									</Button>
								</TableCell>
							</TableRow>
							{expandedUser === entry.userId.toString() && (
								<TableRow className="bg-background hover:bg-background">
									<TableCell colSpan={4} className="border-none p-0">
										<RecommendationDetails
											recommendations={entry.recommendations}
											username={entry.username || entry.userId.toString()}
										/>
									</TableCell>
								</TableRow>
							)}
						</React.Fragment>
					);
				})}
			</TableBody>
		</Table>
	);
};

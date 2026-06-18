// @vitest-environment jsdom
//
// Render tests for the Social Alpha GUI view (SocialAlphaView) and its
// LeaderboardTable. Drives the real components against controlled helper data
// and asserts that populated rows render (rank / username / trustScore with the
// correct color tier), every branch of the wallet gate + loading/error/empty
// states renders, and the single interactive control (View Recs / Hide Recs
// expand toggle) behaves: it opens the RecommendationDetails row, flips the
// chevron/label + data-state, keeps exactly one row open at a time, and
// collapses on re-click. RecommendationDetails is exercised across BUY/SELL,
// ticker-vs-truncated-address, conviction/quote/price, the metrics block
// (profit sign-color, avoided loss, Scam/Rug badge, notes), the >10-rec slice,
// and the empty fallback.
//
// @elizaos/ui surfaces are mocked with lightweight passthroughs that preserve
// the semantics the component relies on (className passthrough so color-tier
// assertions work; data-state passthrough on Button; colSpan on TableCell). The
// real dist barrel transitively pulls in a cloud-ui module with a node-only
// import, so a focused passthrough keeps the test on the component's own logic.

import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardEntry } from "../types";
import { Conviction, SupportedChain } from "../types";

// ---------------------------------------------------------------------------
// Mock the data helpers SocialAlphaView calls. Each test sets the resolved
// values before importing/rendering the view.
// ---------------------------------------------------------------------------
const helpers = vi.hoisted(() => ({
	hasWalletConfigured: vi.fn<() => Promise<boolean>>(),
	fetchLeaderboardData: vi.fn<() => Promise<LeaderboardEntry[]>>(),
}));

vi.mock("./LeaderboardView.helpers", () => helpers);

// ---------------------------------------------------------------------------
// @elizaos/ui passthrough mocks. className/children/props forwarded so the
// component's own class logic (color tiers, data-state) stays observable.
// ---------------------------------------------------------------------------
function passthrough(tag: string) {
	return ({
		children,
		...props
	}: Record<string, unknown> & { children?: React.ReactNode }) =>
		React.createElement(tag, props, children);
}

vi.mock("@elizaos/ui/components", () => ({
	Card: passthrough("div"),
	CardContent: passthrough("div"),
	CardHeader: passthrough("div"),
	CardTitle: passthrough("div"),
	CardDescription: passthrough("div"),
	EmptyState: ({
		title,
		description,
	}: {
		title?: string;
		description?: string;
		icon?: React.ReactNode;
	}) =>
		React.createElement(
			"div",
			{ "data-testid": "empty-state" },
			React.createElement("div", null, title),
			React.createElement("div", null, description),
		),
	Badge: passthrough("span"),
	Button: ({
		children,
		...props
	}: Record<string, unknown> & { children?: React.ReactNode }) =>
		React.createElement("button", { type: "button", ...props }, children),
	Table: passthrough("table"),
	TableBody: passthrough("tbody"),
	TableCell: passthrough("td"),
	TableHead: passthrough("th"),
	TableHeader: passthrough("thead"),
	TableRow: passthrough("tr"),
}));

vi.mock("@elizaos/ui/components/ui/spinner", () => ({
	Spinner: (props: Record<string, unknown>) =>
		React.createElement("span", { "data-testid": "spinner", ...props }),
}));

vi.mock("@elizaos/ui/utils", () => ({
	// Real cn() joins truthy class fragments; replicate so color-tier classes
	// land on the rendered element exactly as the component computes them.
	cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// lucide-react is resolvable from the plugin, but stub it so icon glyph SVGs
// don't add noise; we assert on the BUY/SELL/scam icons via test ids.
vi.mock("lucide-react", () => {
	const icon = (name: string) => (props: Record<string, unknown>) =>
		React.createElement("svg", { "data-icon": name, ...props });
	return {
		Wallet: icon("wallet"),
		Bot: icon("bot"),
		Sparkles: icon("sparkles"),
		TrendingUp: icon("trending-up"),
		TrendingDown: icon("trending-down"),
		ChevronDown: icon("chevron-down"),
		ChevronUp: icon("chevron-up"),
		CheckCircle: icon("check-circle"),
		AlertTriangle: icon("alert-triangle"),
	};
});

import { LeaderboardTable } from "./LeaderboardTable";
import { SocialAlphaView } from "./LeaderboardView";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function buyRec(over: Record<string, unknown> = {}) {
	return {
		id: "rec-buy-1" as never,
		userId: "user-1" as never,
		messageId: "msg-1" as never,
		timestamp: 1_700_000_000_000,
		tokenTicker: "WIF",
		tokenAddress: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
		chain: SupportedChain.SOLANA,
		recommendationType: "BUY" as const,
		conviction: Conviction.HIGH,
		rawMessageQuote: "aping into WIF, this runs",
		priceAtRecommendation: 2.345678,
		metrics: {
			potentialProfitPercent: 42.5,
			isScamOrRug: false,
			notes: "Hit ATH",
			evaluationTimestamp: 1_700_500_000_000,
		},
		...over,
	};
}

function sellRec(over: Record<string, unknown> = {}) {
	return {
		id: "rec-sell-1" as never,
		userId: "user-1" as never,
		messageId: "msg-2" as never,
		timestamp: 1_700_100_000_000,
		// no tokenTicker -> exercises the truncated-address fallback
		tokenAddress: "0xAbCdEf0123456789000000000000000000009999",
		chain: SupportedChain.ETHEREUM,
		recommendationType: "SELL" as const,
		conviction: Conviction.MEDIUM,
		rawMessageQuote: "dumping this, looks like a rug",
		metrics: {
			avoidedLossPercent: 30,
			isScamOrRug: true,
			evaluationTimestamp: 1_700_600_000_000,
		},
		...over,
	};
}

/** Two-entry leaderboard: one high-trust (green tier), one deeply negative. */
function populated(): LeaderboardEntry[] {
	return [
		{
			rank: 1,
			userId: "11111111-1111-1111-1111-111111111111" as never,
			username: "satoshi",
			trustScore: 92.5,
			recommendations: [buyRec(), sellRec()],
		},
		{
			rank: 2,
			// no username -> exercises the userId.substring(0,12) fallback
			userId: "deadbeefdeadbeef-2222-2222-2222-222222222222" as never,
			username: undefined,
			trustScore: -73.2,
			recommendations: [],
		},
	];
}

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("SocialAlphaView wallet gate + leaderboard states", () => {
	beforeEach(() => {
		helpers.hasWalletConfigured.mockReset();
		helpers.fetchLeaderboardData.mockReset();
	});

	it("shows the spinner while the wallet check is pending (walletReady === null)", () => {
		// Never-resolving wallet check keeps walletReady === null.
		helpers.hasWalletConfigured.mockReturnValue(new Promise<boolean>(() => {}));
		helpers.fetchLeaderboardData.mockResolvedValue([]);

		render(<SocialAlphaView />);

		expect(screen.getByTestId("spinner")).toBeTruthy();
		// Gate region: the leaderboard shell header is not present yet.
		expect(screen.queryByText("Alpha Leaderboard")).toBeNull();
	});

	it("renders the 'Wallet required' empty state when no wallet is configured", async () => {
		helpers.hasWalletConfigured.mockResolvedValue(false);
		helpers.fetchLeaderboardData.mockResolvedValue([]);

		render(<SocialAlphaView />);

		await screen.findByText("Wallet required");
		expect(
			screen.getByText(/Configure the agent wallet to enable it\./),
		).toBeTruthy();
		// The fetch effect is gated on walletReady, so it must NOT run.
		expect(helpers.fetchLeaderboardData).not.toHaveBeenCalled();
		// No leaderboard shell rendered.
		expect(screen.queryByText("Alpha Leaderboard")).toBeNull();
	});

	it("renders the populated leaderboard shell with ranks, usernames, and color-tiered trust scores", async () => {
		helpers.hasWalletConfigured.mockResolvedValue(true);
		helpers.fetchLeaderboardData.mockResolvedValue(populated());

		render(<SocialAlphaView />);

		// Shell chrome appears once walletReady flips true.
		await screen.findByText("Alpha Leaderboard");
		expect(screen.getByText("Top Callers")).toBeTruthy();

		// Wait for the async fetch effect to populate the table (row data present).
		await screen.findByText("satoshi");

		// Header columns of the table.
		expect(screen.getByText("Rank")).toBeTruthy();
		expect(screen.getByText("Username")).toBeTruthy();
		expect(screen.getByText("Trust Score")).toBeTruthy();
		expect(screen.getByText("Actions")).toBeTruthy();
		const greenCell = screen.getByText("92.50");
		expect(greenCell.className).toContain("text-green-500"); // > 50 tier

		// Row 2: username absent -> userId.substring(0,12) + "..." fallback.
		expect(screen.getByText("deadbeefdead...")).toBeTruthy();
		const redCell = screen.getByText("-73.20");
		expect(redCell.className).toContain("text-red-500"); // < -50 tier

		// Both rank values render.
		expect(screen.getByText("1")).toBeTruthy();
		expect(screen.getByText("2")).toBeTruthy();
	});

	it("renders the in-card error state when the leaderboard fetch rejects", async () => {
		helpers.hasWalletConfigured.mockResolvedValue(true);
		helpers.fetchLeaderboardData.mockRejectedValue(
			new Error("Leaderboard API response did not include a data array"),
		);

		render(<SocialAlphaView />);

		await screen.findByText("Error Fetching Leaderboard:");
		expect(
			screen.getByText("Leaderboard API response did not include a data array"),
		).toBeTruthy();
	});

	it("renders the 'Be the first' empty copy when the leaderboard resolves to []", async () => {
		helpers.hasWalletConfigured.mockResolvedValue(true);
		helpers.fetchLeaderboardData.mockResolvedValue([]);

		render(<SocialAlphaView />);

		await screen.findByText("Alpha Leaderboard");
		await screen.findByText(/Be the first to make a recommendation!/);
	});
});

describe("SocialAlphaView expand toggle (single-active expansion)", () => {
	beforeEach(() => {
		helpers.hasWalletConfigured.mockResolvedValue(true);
	});

	it("opens RecommendationDetails, flips the label/data-state, then collapses on re-click", async () => {
		helpers.fetchLeaderboardData.mockResolvedValue(populated());
		render(<SocialAlphaView />);
		await screen.findByText("satoshi");

		// Two rows -> two toggle buttons; both start "View Recs" / closed.
		const buttons = screen.getAllByRole("button");
		const row1Btn = buttons.find((b) =>
			b.textContent?.includes("View Recs"),
		) as HTMLButtonElement;
		expect(row1Btn).toBeTruthy();
		expect(row1Btn.getAttribute("data-state")).toBe("closed");

		// Open row 1.
		fireEvent.click(row1Btn);
		await screen.findByText("Recommendations by satoshi");
		const hideBtn = screen
			.getAllByRole("button")
			.find((b) => b.textContent?.includes("Hide Recs")) as HTMLButtonElement;
		expect(hideBtn).toBeTruthy();
		expect(hideBtn.getAttribute("data-state")).toBe("open");

		// Collapse via re-click.
		fireEvent.click(hideBtn);
		await waitFor(() => {
			expect(screen.queryByText("Recommendations by satoshi")).toBeNull();
		});
	});

	it("opening a second row closes the first (only one expanded at a time)", async () => {
		// Give the second (negative-trust) user some recs so its panel renders.
		const data = populated();
		data[1].recommendations = [buyRec({ id: "rec-buy-2" as never })];
		helpers.fetchLeaderboardData.mockResolvedValue(data);

		render(<SocialAlphaView />);
		await screen.findByText("satoshi");

		const openRow1 = () =>
			screen
				.getAllByRole("button")
				.find((b) => b.textContent?.includes("View Recs")) as HTMLButtonElement;

		// Open row 1.
		fireEvent.click(openRow1());
		await screen.findByText("Recommendations by satoshi");

		// Now exactly one "View Recs" remains (row 2). Open it.
		const remaining = screen
			.getAllByRole("button")
			.filter((b) => b.textContent?.includes("View Recs"));
		expect(remaining).toHaveLength(1);
		fireEvent.click(remaining[0]);

		// Row 2's details (username falls back to userId) appear and row 1's go away.
		await screen.findByText(/Recommendations by deadbeefdead/);
		await waitFor(() => {
			expect(screen.queryByText("Recommendations by satoshi")).toBeNull();
		});
	});
});

describe("LeaderboardTable RecommendationDetails branches", () => {
	function tableWith(entry: LeaderboardEntry) {
		render(<LeaderboardTable data={[entry]} />);
		const viewBtn = screen
			.getAllByRole("button")
			.find((b) => b.textContent?.includes("View Recs")) as HTMLButtonElement;
		fireEvent.click(viewBtn);
	}

	it("renders BUY/SELL icons, ticker vs truncated address, conviction, quote, price, and the metrics block", async () => {
		const entry: LeaderboardEntry = {
			rank: 1,
			userId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as never,
			username: "caller",
			trustScore: 12.3,
			recommendations: [buyRec(), sellRec()],
		};
		tableWith(entry);

		await screen.findByText("Recommendations by caller");

		// BUY -> ticker shown; SELL -> truncated address (first6 + "..." + last4).
		expect(screen.getByText("WIF")).toBeTruthy();
		// 0xAbCdEf...9999
		expect(screen.getByText("0xAbCd...9999")).toBeTruthy();

		// BUY/SELL trend icons present.
		expect(document.querySelector('[data-icon="trending-up"]')).toBeTruthy();
		expect(document.querySelector('[data-icon="trending-down"]')).toBeTruthy();

		// Recommendation type badges (BUY + SELL).
		expect(screen.getByText("BUY")).toBeTruthy();
		expect(screen.getByText("SELL")).toBeTruthy();

		// Conviction badges.
		expect(screen.getByText(Conviction.HIGH)).toBeTruthy();
		expect(screen.getByText(Conviction.MEDIUM)).toBeTruthy();

		// Raw message quotes (rendered inside curly quotes around the text node).
		expect(screen.getByText(/aping into WIF, this runs/)).toBeTruthy();
		expect(screen.getByText(/dumping this, looks like a rug/)).toBeTruthy();

		// priceAtRecommendation formatted with $ and 2-6 fraction digits.
		expect(screen.getByText(/\$2\.345678/)).toBeTruthy();

		// Metrics: profit % (green for positive sign), avoided loss %, scam badge, notes.
		const profit = screen.getByText("42.5%");
		expect(profit.className).toContain("text-green-500");
		expect(screen.getByText("30.0%")).toBeTruthy();
		expect(screen.getByText(/Flagged:/)).toBeTruthy();
		expect(screen.getByText(/Notes: Hit ATH/)).toBeTruthy();
		expect(document.querySelector('[data-icon="alert-triangle"]')).toBeTruthy();
	});

	it("colors a negative potentialProfitPercent red and omits scam badge / price when absent", async () => {
		const entry: LeaderboardEntry = {
			rank: 1,
			userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" as never,
			username: "loser",
			trustScore: -3,
			recommendations: [
				buyRec({
					id: "rec-loss" as never,
					priceAtRecommendation: undefined,
					metrics: {
						potentialProfitPercent: -18.4,
						isScamOrRug: false,
						evaluationTimestamp: 1_700_700_000_000,
					},
				}),
			],
		};
		tableWith(entry);

		await screen.findByText("Recommendations by loser");
		const loss = screen.getByText("-18.4%");
		expect(loss.className).toContain("text-red-500");
		// isScamOrRug false -> no flag badge.
		expect(screen.queryByText(/Flagged:/)).toBeNull();
		// No priceAtRecommendation -> no "Price at Rec" line.
		expect(screen.queryByText(/Price at Rec/)).toBeNull();
	});

	it("slices to the first 10 recommendations", async () => {
		const recs = Array.from({ length: 14 }, (_, i) =>
			buyRec({
				id: `rec-${i}` as never,
				tokenTicker: `TKN${i}`,
				rawMessageQuote: `quote number ${i}`,
				metrics: undefined,
				priceAtRecommendation: undefined,
			}),
		);
		const entry: LeaderboardEntry = {
			rank: 1,
			userId: "cccccccc-cccc-cccc-cccc-cccccccccccc" as never,
			username: "spammer",
			trustScore: 5,
			recommendations: recs,
		};
		tableWith(entry);

		await screen.findByText("Recommendations by spammer");
		// First 10 (TKN0..TKN9) render; TKN10..TKN13 are sliced off.
		expect(screen.getByText("TKN0")).toBeTruthy();
		expect(screen.getByText("TKN9")).toBeTruthy();
		expect(screen.queryByText("TKN10")).toBeNull();
		expect(screen.queryByText("TKN13")).toBeNull();
	});

	it("renders the empty fallback when a user has no recommendations", async () => {
		const entry: LeaderboardEntry = {
			rank: 1,
			userId: "dddddddd-dddd-dddd-dddd-dddddddddddd" as never,
			username: "newbie",
			trustScore: 0,
			recommendations: [],
		};
		tableWith(entry);

		await screen.findByText(
			/No specific recommendations recorded for newbie yet\./,
		);
	});

	it("renders the table-level empty fallback for an empty data array", () => {
		render(<LeaderboardTable data={[]} />);
		expect(
			screen.getByText(/No leaderboard data available yet\./),
		).toBeTruthy();
		expect(document.querySelector('[data-icon="bot"]')).toBeTruthy();
	});
});

describe("LeaderboardTable trust-score color tiers", () => {
	function cellFor(score: number): HTMLElement {
		cleanup();
		render(
			<LeaderboardTable
				data={[
					{
						rank: 1,
						userId: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee" as never,
						username: "tier",
						trustScore: score,
						recommendations: [],
					},
				]}
			/>,
		);
		return screen.getByText(score.toFixed(2));
	}

	it("maps each numeric range to the documented color class", () => {
		expect(cellFor(80).className).toContain("text-green-500"); // > 50
		expect(cellFor(20).className).toContain("text-green-600/80"); // > 5
		expect(cellFor(0).className).toContain("text-foreground/70"); // neutral
		expect(cellFor(-20).className).toContain("text-red-600/80"); // < -5
		expect(cellFor(-80).className).toContain("text-red-500"); // < -50
	});
});

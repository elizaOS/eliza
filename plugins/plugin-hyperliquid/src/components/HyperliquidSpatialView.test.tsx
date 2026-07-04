/**
 * Tests for `HyperliquidSpatialView`, the single component source rendered
 * across TUI, GUI, and XR modalities: width-contract terminal rendering,
 * DOM output with agent hooks, terminal-view registration, the account-health
 * summary strip, per-position detail, and closed-position filtering. Pure
 * component rendering against static snapshots — no live model or network.
 */
import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
	getTerminalView,
	registerSpatialTerminalView,
	renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
	type HyperliquidSnapshot,
	HyperliquidSpatialView,
} from "./HyperliquidSpatialView.tsx";

const snapshot: HyperliquidSnapshot = {
	status: {
		publicReadReady: true,
		signerReady: true,
		executionReady: false,
		credentialMode: "managed_vault",
		accountAddress: "0x1234567890abcdef1234567890abcdef12345678",
		vaultReady: true,
		executionBlockedReason: "Execution disabled in this read-only app.",
	},
	markets: [
		{
			name: "BTC",
			index: 0,
			szDecimals: 5,
			maxLeverage: 50,
			onlyIsolated: false,
			isDelisted: false,
		},
		{
			name: "ETH",
			index: 1,
			szDecimals: 4,
			maxLeverage: 25,
			onlyIsolated: true,
			isDelisted: false,
		},
	],
	positions: [
		{
			coin: "BTC",
			size: "0.5",
			entryPx: "60000",
			positionValue: "30000",
			unrealizedPnl: "120.5",
			returnOnEquity: "0.04",
			liquidationPx: "45000",
			marginUsed: "3000",
			leverageType: "cross",
			leverageValue: 10,
			markPx: "60000",
			distanceToLiquidationPct: 25,
		},
	],
	orders: [
		{
			coin: "ETH",
			side: "B",
			limitPx: "3000",
			size: "1.2",
			oid: 987654,
			timestamp: 1718000000000,
			reduceOnly: false,
			orderType: "Limit",
			tif: "Gtc",
			cloid: null,
		},
	],
};

const view = <HyperliquidSpatialView snapshot={snapshot} />;

describe("HyperliquidSpatialView one source, three modalities", () => {
	it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
		for (const width of [54, 32]) {
			const lines = renderViewToLines(view, width);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
			const flat = lines.join("\n");
			expect(flat).toContain("read-ready");
			expect(flat).toContain("BTC");
			expect(flat).toContain("Refresh");
		}
	});

	it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
		const gui = renderToStaticMarkup(
			<SpatialSurface modality="gui">{view}</SpatialSurface>,
		);
		const xr = renderToStaticMarkup(
			<SpatialSurface modality="xr">{view}</SpatialSurface>,
		);
		expect(gui).toContain('data-spatial-surface="gui"');
		expect(xr).toContain('data-spatial-surface="xr"');
		for (const html of [gui, xr]) {
			expect(html).toContain("BTC");
			expect(html).toContain("read-ready");
			expect(html).toContain('data-agent-id="refresh"');
		}
	});

	it("registers as a terminal view the agent terminal can mount and render", () => {
		const unregister = registerSpatialTerminalView(
			"hyperliquid-test",
			() => view,
		);
		try {
			const component = getTerminalView("hyperliquid-test");
			expect(component).toBeTruthy();
			const lines = component?.render(50) ?? [];
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBe(50);
			expect(lines.join("\n")).toContain("BTC");
		} finally {
			unregister();
		}
	});
});

// The account-health summary strip and per-position detail (side, leverage,
// notional, entry, distance-to-liquidation, pnl) live in this one spatial
// source, including the #8796 missing-DTO-field crash guard.
describe("HyperliquidSpatialView account-health + position detail", () => {
	const withSummary: HyperliquidSnapshot = {
		...snapshot,
		summary: {
			accountValue: "996.19",
			totalNotionalPosition: "7000",
			totalMarginUsed: "700",
			totalRawUsd: "996.19",
			withdrawable: "296.19",
			totalUnrealizedPnl: "10.00",
			effectiveLeverage: 7.02,
		},
	};

	it("renders the account-health strip and the position detail", () => {
		const html = renderToStaticMarkup(
			<SpatialSurface modality="gui">
				<HyperliquidSpatialView snapshot={withSummary} />
			</SpatialSurface>,
		);
		// Account-health summary (effective leverage + withdrawable + pnl).
		expect(html).toContain("7.02x");
		expect(html).toContain("296");
		// Position detail: side, derived liquidation distance, notional.
		expect(html).toContain("long");
		expect(html).toContain("25% to liq");
		expect(html).toContain("30,000");
	});

	it("does not crash when distanceToLiquidationPct is a missing DTO field (#8796)", () => {
		const broken: HyperliquidSnapshot = {
			...snapshot,
			positions: [{ ...snapshot.positions[0] }],
		};
		delete (broken.positions[0] as { distanceToLiquidationPct?: number | null })
			.distanceToLiquidationPct;
		expect(() =>
			renderToStaticMarkup(
				<SpatialSurface modality="gui">
					<HyperliquidSpatialView snapshot={broken} />
				</SpatialSurface>,
			),
		).not.toThrow();
	});

	it("hides closed (zero-size) positions, matching the retired open-only table", () => {
		const closed: HyperliquidSnapshot = {
			...snapshot,
			positions: [{ ...snapshot.positions[0], size: "0", coin: "FLAT" }],
		};
		const html = renderToStaticMarkup(
			<SpatialSurface modality="gui">
				<HyperliquidSpatialView snapshot={closed} />
			</SpatialSurface>,
		);
		expect(html).not.toContain("FLAT");
	});
});

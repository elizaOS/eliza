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
	EMPTY_SOCIAL_ALPHA_SNAPSHOT,
	type LeaderRow,
	type SocialAlphaSnapshot,
	SocialAlphaSpatialView,
} from "./SocialAlphaSpatialView.tsx";

function row(overrides: Partial<LeaderRow> & { userId: string }): LeaderRow {
	return {
		rank: "1",
		name: `Caller ${overrides.userId}`,
		score: "0.00",
		...overrides,
	};
}

const snapshot: SocialAlphaSnapshot = {
	state: "ready",
	leading: "leading: alice (12.50)",
	rows: [
		row({ userId: "u1", rank: "1", name: "alice", score: "12.50" }),
		row({
			userId: "u2",
			rank: "2",
			name: "a-very-long-username-that-exceeds-the-narrow-width",
			score: "3.25",
		}),
		row({ userId: "u3", rank: "3", name: "carol", score: "-7.00" }),
	],
};

const view = <SocialAlphaSpatialView snapshot={snapshot} />;

describe("SocialAlphaSpatialView one source, three modalities", () => {
	it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
		for (const width of [54, 32]) {
			const lines = renderViewToLines(view, width);
			for (const line of lines) expect(visibleWidth(line)).toBe(width);
			const flat = lines.join("\n");
			expect(flat).toContain("Alpha Leaderboard");
			expect(flat).toContain("alice");
			expect(flat).toContain("12.50");
			expect(flat).toContain("carol");
			expect(flat).toContain("leading");
			expect(flat).toContain("callers");
		}
	});

	it("TUI: narrow width 40 keeps every line within the contract", () => {
		const lines = renderViewToLines(view, 40);
		for (const line of lines) expect(visibleWidth(line)).toBe(40);
		expect(lines.join("\n")).toContain("alice");
	});

	it("GUI + XR: renders DOM with the surface marker and caller rows, XR scaled up", () => {
		const gui = renderToStaticMarkup(
			<SpatialSurface modality="gui">{view}</SpatialSurface>,
		);
		const xr = renderToStaticMarkup(
			<SpatialSurface modality="xr">{view}</SpatialSurface>,
		);
		expect(gui).toContain('data-spatial-surface="gui"');
		expect(xr).toContain('data-spatial-surface="xr"');
		for (const html of [gui, xr]) {
			expect(html).toContain("alice");
			expect(html).toContain("carol");
			expect(html).toContain('data-agent-id="caller-u1"');
			expect(html).toContain('data-agent-id="open-u1"');
		}
	});

	it("loading state renders a quiet loading line", () => {
		const lines = renderViewToLines(
			<SocialAlphaSpatialView snapshot={EMPTY_SOCIAL_ALPHA_SNAPSHOT} />,
			54,
		);
		for (const line of lines) expect(visibleWidth(line)).toBe(54);
		expect(lines.join("\n")).toContain("Loading leaderboard");
	});

	it("wallet-required state renders the Connect wallet affordance", () => {
		const walletRequired: SocialAlphaSnapshot = {
			state: "wallet-required",
			rows: [],
			leading: "",
		};
		const html = renderToStaticMarkup(
			<SpatialSurface modality="gui">
				<SocialAlphaSpatialView snapshot={walletRequired} />
			</SpatialSurface>,
		);
		expect(html).toContain("Wallet required");
		expect(html).toContain('data-agent-id="connect-wallet"');
	});

	it("empty state renders the honest no-callers line", () => {
		const empty: SocialAlphaSnapshot = {
			state: "empty",
			rows: [],
			leading: "",
		};
		const lines = renderViewToLines(
			<SocialAlphaSpatialView snapshot={empty} />,
			54,
		);
		for (const line of lines) expect(visibleWidth(line)).toBe(54);
		expect(lines.join("\n")).toContain("No callers yet");
	});

	it("error state renders the message and a Retry control", () => {
		const error: SocialAlphaSnapshot = {
			state: "error",
			rows: [],
			leading: "",
			error: "boom",
		};
		const lines = renderViewToLines(
			<SocialAlphaSpatialView snapshot={error} />,
			54,
		);
		for (const line of lines) expect(visibleWidth(line)).toBe(54);
		const flat = lines.join("\n");
		expect(flat).toContain("boom");
		expect(flat).toContain("Retry");

		const html = renderToStaticMarkup(
			<SpatialSurface modality="gui">
				<SocialAlphaSpatialView snapshot={error} />
			</SpatialSurface>,
		);
		expect(html).toContain('data-agent-id="retry"');
	});

	it("registers as a terminal view the agent terminal can mount and render", () => {
		const unregister = registerSpatialTerminalView(
			"social-alpha-test",
			() => view,
		);
		try {
			const component = getTerminalView("social-alpha-test");
			expect(component).toBeTruthy();
			const lines = component?.render(50) ?? [];
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBe(50);
			expect(lines.join("\n")).toContain("alice");
		} finally {
			unregister();
		}
	});
});

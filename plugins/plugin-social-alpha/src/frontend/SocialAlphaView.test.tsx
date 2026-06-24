// @vitest-environment jsdom

/**
 * Drives the unified SocialAlphaView (the single GUI/XR data wrapper) through
 * the rendered DOM: the same component the bundle exports for both the "gui" and
 * "xr" modalities. It is a read-only trust leaderboard gated behind the agent
 * wallet:
 *   client.getWalletAddresses()       -> wallet gate
 *   GET /api/social-alpha/leaderboard -> ranked LeaderboardEntry[]
 *
 * Every test injects the `fetchers` seam so the suite stays offline. We assert
 * the rendered spatial DOM across the five states (loading, wallet-required,
 * error + Retry, empty, populated) and that the owner actions (Connect wallet,
 * Open caller) route through the assistant chat — no fabricated data.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LeaderboardEntry } from "../types";

// `@elizaos/ui` is the giant renderer barrel; SocialAlphaView only touches
// `client.sendChatMessage()` (the connect-wallet / open-caller affordances).
// The spatial primitives come from the separate `@elizaos/ui/spatial` subpath,
// which is not mocked. The data helpers are reached through the injected
// fetchers seam, so `./LeaderboardView.helpers` is never hit here.
const { sendChatMessage } = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("@elizaos/ui", () => ({
	client: {
		getBaseUrl: () => "http://test.local",
		sendChatMessage,
	},
}));

import {
	type SocialAlphaFetchers,
	SocialAlphaView,
} from "./SocialAlphaView.tsx";

let seq = 0;
function entry(overrides: Partial<LeaderboardEntry> = {}): LeaderboardEntry {
	seq += 1;
	return {
		rank: seq,
		userId:
			`00000000-0000-0000-0000-00000000000${seq}` as LeaderboardEntry["userId"],
		username: `caller-${seq}`,
		trustScore: 0,
		recommendations: [],
		...overrides,
	};
}

function populated(): LeaderboardEntry[] {
	seq = 0;
	return [
		entry({ rank: 1, username: "alice", trustScore: 12.5 }),
		entry({ rank: 2, username: "bob", trustScore: 3.25 }),
		entry({ rank: 3, username: "carol", trustScore: -7 }),
	];
}

function makeFetchers(
	overrides: Partial<SocialAlphaFetchers> = {},
): SocialAlphaFetchers {
	return {
		checkWallet: async () => true,
		fetchLeaderboard: async () => populated(),
		...overrides,
	};
}

function agent(agentId: string): HTMLElement {
	const el = document.querySelector(`[data-agent-id="${agentId}"]`);
	if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
	return el as HTMLElement;
}

afterEach(() => {
	cleanup();
	sendChatMessage.mockClear();
});

describe("SocialAlphaView — states", () => {
	it("shows the loading state while the wallet check is in flight", () => {
		const never = new Promise<never>(() => {});
		render(
			React.createElement(SocialAlphaView, {
				fetchers: makeFetchers({ checkWallet: () => never }),
			}),
		);
		expect(screen.getByText("Loading leaderboard")).toBeTruthy();
	});

	it("shows the wallet-required state when no wallet is configured", async () => {
		render(
			React.createElement(SocialAlphaView, {
				fetchers: makeFetchers({ checkWallet: async () => false }),
			}),
		);
		await screen.findByText("Wallet required");
		expect(screen.queryByText("alice")).toBeNull();
	});

	it("routes the Connect wallet affordance through the assistant chat", async () => {
		render(
			React.createElement(SocialAlphaView, {
				fetchers: makeFetchers({ checkWallet: async () => false }),
			}),
		);
		await screen.findByText("Wallet required");
		fireEvent.click(agent("connect-wallet"));
		expect(sendChatMessage).toHaveBeenCalledTimes(1);
	});

	it("renders the populated leaderboard with the leading-caller line", async () => {
		render(React.createElement(SocialAlphaView, { fetchers: makeFetchers() }));
		await screen.findByText("alice");
		expect(screen.getByText("bob")).toBeTruthy();
		expect(screen.getByText("carol")).toBeTruthy();
		// Pre-formatted strings are printed, not computed in the view.
		expect(screen.getByText("12.50")).toBeTruthy();
		expect(screen.getByText("-7.00")).toBeTruthy();
		expect(screen.getByText("leading: alice (12.50)")).toBeTruthy();
	});

	it("drills into a caller through the assistant chat", async () => {
		const entries = populated();
		render(
			React.createElement(SocialAlphaView, {
				fetchers: makeFetchers({ fetchLeaderboard: async () => entries }),
			}),
		);
		await screen.findByText("alice");
		fireEvent.click(agent(`open-${entries[0].userId}`));
		expect(sendChatMessage).toHaveBeenCalledTimes(1);
		expect(sendChatMessage.mock.calls[0][0]).toContain(entries[0].userId);
	});

	it("shows the empty state when the route returns no callers", async () => {
		render(
			React.createElement(SocialAlphaView, {
				fetchers: makeFetchers({ fetchLeaderboard: async () => [] }),
			}),
		);
		await screen.findByText("No callers");
		expect(screen.queryByText("alice")).toBeNull();
	});

	it("shows the error state with a Retry that refetches into populated", async () => {
		let attempt = 0;
		const fetchLeaderboard = async () => {
			attempt += 1;
			if (attempt === 1) throw new Error("boom");
			return populated();
		};
		render(
			React.createElement(SocialAlphaView, {
				fetchers: makeFetchers({ fetchLeaderboard }),
			}),
		);
		await screen.findByText("boom");
		fireEvent.click(agent("retry"));
		await screen.findByText("alice");
	});

	it("falls back to a short id when a caller has no username", async () => {
		const longId =
			"abcdef01-2345-6789-abcd-ef0123456789" as LeaderboardEntry["userId"];
		render(
			React.createElement(SocialAlphaView, {
				fetchers: makeFetchers({
					fetchLeaderboard: async () => [
						{
							rank: 1,
							userId: longId,
							trustScore: 1,
							recommendations: [],
						},
					],
				}),
			}),
		);
		await screen.findByText("abcdef01-234…");
	});
});

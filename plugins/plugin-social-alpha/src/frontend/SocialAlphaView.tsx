/**
 * SocialAlphaView — the single GUI/XR data wrapper for the alpha trust
 * leaderboard.
 *
 * It owns the live leaderboard data (the fetcher seam over the plugin's
 * read-only route, the wallet gate, the quiet background poll, and the
 * wire->display projection) and renders the one presentational
 * {@link SocialAlphaSpatialView} inside a {@link SpatialSurface}. Omitting the
 * `modality` prop lets `SpatialSurface` auto-detect GUI vs XR, so the SAME
 * component serves both surfaces; the TUI surface renders the same
 * `SocialAlphaSpatialView` through the terminal registry (see
 * `../register-terminal-view.tsx`).
 *
 * Data source (the plugin owns the leaderboard route):
 *   GET /api/social-alpha/leaderboard -> LeaderboardEntry[]  (ranked)
 *   client.getWalletAddresses()       -> wallet gate
 *
 * The board is read-only. The only owner actions route through the assistant
 * chat (no fabricated state): `retry` (reload after an error), `connect-wallet`
 * (ask the assistant to set up the agent wallet), and `open:<userId>` (drill
 * into a caller).
 */

import { client } from "@elizaos/ui";

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LeaderboardEntry } from "../types";
import {
	fetchLeaderboardData,
	hasWalletConfigured,
} from "./LeaderboardView.helpers";
import {
	EMPTY_SOCIAL_ALPHA_SNAPSHOT,
	type LeaderRow,
	type SocialAlphaSnapshot,
	SocialAlphaSpatialView,
} from "./SocialAlphaSpatialView.tsx";

// ---------------------------------------------------------------------------
// Fetcher seam — default to the real helpers; tests inject offline fakes.
// ---------------------------------------------------------------------------

export interface SocialAlphaFetchers {
	checkWallet: () => Promise<boolean>;
	fetchLeaderboard: () => Promise<LeaderboardEntry[]>;
}

const defaultFetchers: SocialAlphaFetchers = {
	checkWallet: hasWalletConfigured,
	fetchLeaderboard: fetchLeaderboardData,
};

export interface SocialAlphaViewProps {
	/** Test/host injection seam. Defaults to the real wallet + leaderboard helpers. */
	fetchers?: SocialAlphaFetchers;
}

// ---------------------------------------------------------------------------
// Wire -> display projection (client displays, never computes).
// ---------------------------------------------------------------------------

function shortId(userId: string): string {
	return userId.length > 12 ? `${userId.slice(0, 12)}…` : userId;
}

function toRow(entry: LeaderboardEntry): LeaderRow {
	return {
		userId: entry.userId,
		rank: entry.rank !== undefined ? String(entry.rank) : "",
		name: entry.username ?? shortId(entry.userId),
		score: entry.trustScore.toFixed(2),
	};
}

function leadingLine(entries: LeaderboardEntry[]): string {
	const leader = entries[0];
	if (!leader?.username) return "";
	return `leading: ${leader.username} (${leader.trustScore.toFixed(2)})`;
}

// ---------------------------------------------------------------------------
// Fetch-driven state machine.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 15_000;

type LoadState =
	| { kind: "loading" }
	| { kind: "wallet-required" }
	| { kind: "error"; message: string }
	| { kind: "ready"; entries: LeaderboardEntry[] };

/**
 * Route a natural-language request through the assistant chat. `client` does
 * not type `sendChatMessage`, so read it through a narrow optional-method view
 * and call it only when present — best-effort dispatch, no fabricated state.
 */
function requestThroughChat(text: string): void {
	const send = (client as { sendChatMessage?: (text: string) => void })
		.sendChatMessage;
	send?.(text);
}

export function SocialAlphaView(props: SocialAlphaViewProps = {}): ReactNode {
	const fetchers = props.fetchers ?? defaultFetchers;
	const [state, setState] = useState<LoadState>({ kind: "loading" });

	const fetchersRef = useRef(fetchers);
	fetchersRef.current = fetchers;

	const load = useCallback(() => {
		let cancelled = false;
		setState({ kind: "loading" });
		void (async () => {
			try {
				const ready = await fetchersRef.current.checkWallet();
				if (cancelled) return;
				if (!ready) {
					setState({ kind: "wallet-required" });
					return;
				}
				const entries = await fetchersRef.current.fetchLeaderboard();
				if (cancelled) return;
				setState({ kind: "ready", entries });
			} catch (error: unknown) {
				if (cancelled) return;
				setState({
					kind: "error",
					message:
						error instanceof Error
							? error.message
							: "Could not load leaderboard.",
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => load(), [load]);

	// Background poll: refresh the leaderboard on an interval without flashing the
	// loading state. Transient poll failures are ignored — the explicit Retry path
	// is what surfaces errors. The poll only runs once the wallet gate is open.
	useEffect(() => {
		if (state.kind !== "ready") return;
		const id = setInterval(() => {
			fetchersRef.current
				.fetchLeaderboard()
				.then((entries) => {
					setState((prev) =>
						prev.kind === "ready" ? { kind: "ready", entries } : prev,
					);
				})
				// error-policy:J5 transient background-poll failure; errors surface via the explicit load()/Retry path above
				.catch(() => {});
		}, POLL_INTERVAL_MS);
		return () => clearInterval(id);
	}, [state.kind]);

	const snapshot = useMemo<SocialAlphaSnapshot>(() => {
		if (state.kind === "loading") return EMPTY_SOCIAL_ALPHA_SNAPSHOT;
		if (state.kind === "wallet-required") {
			return { state: "wallet-required", rows: [], leading: "" };
		}
		if (state.kind === "error") {
			return { state: "error", rows: [], leading: "", error: state.message };
		}
		if (state.entries.length === 0) {
			return { state: "empty", rows: [], leading: "" };
		}
		return {
			state: "ready",
			rows: state.entries.map(toRow),
			leading: leadingLine(state.entries),
		};
	}, [state]);

	const onAction = useCallback(
		(action: string) => {
			if (action === "retry") {
				load();
				return;
			}
			if (action === "connect-wallet") {
				requestThroughChat("Set up the agent wallet for Social Alpha.");
				return;
			}
			if (action.startsWith("open:")) {
				const userId = action.slice("open:".length);
				requestThroughChat(
					`Show me the Social Alpha recommendations for caller ${userId}.`,
				);
			}
		},
		[load],
	);

	return <SocialAlphaSpatialView snapshot={snapshot} onAction={onAction} />;
}

export default SocialAlphaView;

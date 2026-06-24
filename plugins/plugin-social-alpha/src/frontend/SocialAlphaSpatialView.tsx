/**
 * SocialAlphaSpatialView — the alpha trust leaderboard authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `../register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no browser/client import).
 *
 * Every derived value — the leading-caller line, each row's formatted trust
 * score — is computed in the data wrapper ({@link ./SocialAlphaView.tsx}) and
 * handed in already formatted; this component never fetches or computes — it
 * displays the snapshot and dispatches actions.
 */

import { Button, Card, HStack, List, Text, VStack } from "@elizaos/ui/spatial";

/** A single leaderboard caller, already projected to display shape. */
export interface LeaderRow {
	/** Stable id used to key rows and build the open-caller action. */
	userId: string;
	/** Pre-formatted rank label (e.g. "1"), or empty when unranked. */
	rank: string;
	/** Display name (username, or a short id when anonymous). */
	name: string;
	/** Pre-formatted trust score (e.g. "12.50"). */
	score: string;
}

/** Which render state the leaderboard is in. */
export type SocialAlphaViewState =
	| "loading"
	| "wallet-required"
	| "error"
	| "empty"
	| "ready";

export interface SocialAlphaSnapshot {
	/** The leaderboard state machine. */
	state: SocialAlphaViewState;
	/** Ranked callers (only meaningful when state === "ready"). */
	rows: LeaderRow[];
	/** Pre-formatted leading-caller line, or empty when none. */
	leading: string;
	/** Error message when state === "error". */
	error?: string;
}

export const EMPTY_SOCIAL_ALPHA_SNAPSHOT: SocialAlphaSnapshot = {
	state: "loading",
	rows: [],
	leading: "",
};

export interface SocialAlphaSpatialViewProps {
	snapshot: SocialAlphaSnapshot;
	/**
	 * Dispatch by action id: `retry` (reload after an error),
	 * `connect-wallet` (route a wallet-setup request), `open:<userId>`
	 * (drill into a caller through chat).
	 */
	onAction?: (action: string) => void;
}

export function SocialAlphaSpatialView({
	snapshot,
	onAction,
}: SocialAlphaSpatialViewProps) {
	const dispatch = (action: string) => () => onAction?.(action);

	return (
		<Card gap={1} padding={1}>
			{snapshot.state === "loading" ? (
				<Text tone="muted" align="center" style="caption">
					Loading leaderboard
				</Text>
			) : snapshot.state === "wallet-required" ? (
				<WalletRequiredBody dispatch={dispatch} />
			) : snapshot.state === "error" ? (
				<ErrorBody snapshot={snapshot} dispatch={dispatch} />
			) : snapshot.state === "empty" ? (
				<EmptyBody />
			) : (
				<ReadyBody snapshot={snapshot} dispatch={dispatch} />
			)}
		</Card>
	);
}

function WalletRequiredBody({
	dispatch,
}: {
	dispatch: (action: string) => () => void;
}) {
	return (
		<>
			<Text bold>Wallet required</Text>
			<HStack gap={1}>
				<Button agent="connect-wallet" onPress={dispatch("connect-wallet")}>
					Wallet
				</Button>
			</HStack>
		</>
	);
}

function ErrorBody({
	snapshot,
	dispatch,
}: {
	snapshot: SocialAlphaSnapshot;
	dispatch: (action: string) => () => void;
}) {
	return (
		<>
			<Text bold>Could not load leaderboard</Text>
			<Text tone="danger" style="caption">
				{snapshot.error ?? "Could not load leaderboard."}
			</Text>
			<HStack gap={1}>
				<Button agent="retry" onPress={dispatch("retry")}>
					Retry
				</Button>
			</HStack>
		</>
	);
}

function EmptyBody() {
	return <Text bold>None</Text>;
}

function ReadyBody({
	snapshot,
	dispatch,
}: {
	snapshot: SocialAlphaSnapshot;
	dispatch: (action: string) => () => void;
}) {
	return (
		<>
			{snapshot.leading ? (
				<Text tone="primary" style="caption">
					{snapshot.leading}
				</Text>
			) : null}
			<List gap={0}>
				{snapshot.rows.map((row) => (
					<LeaderRowView key={row.userId} row={row} dispatch={dispatch} />
				))}
			</List>
		</>
	);
}

function LeaderRowView({
	row,
	dispatch,
}: {
	row: LeaderRow;
	dispatch: (action: string) => () => void;
}) {
	// Rank + name share the first line (name fills, Card ellipsizes a long one);
	// the score and Open control sit on the second line so the row stays
	// narrow-safe at width 40 regardless of username length.
	return (
		<VStack gap={0} agent={`caller-${row.userId}`}>
			<HStack gap={1} align="center">
				<Text tone="primary" wrap={false}>
					{row.rank}
				</Text>
				<Text bold grow={1} wrap={false}>
					{row.name}
				</Text>
			</HStack>
			<HStack gap={1} align="center">
				<Text style="caption" tone="muted" grow={1} wrap={false}>
					{row.score}
				</Text>
				<Button
					agent={`open-${row.userId}`}
					variant="ghost"
					onPress={dispatch(`open:${row.userId}`)}
				>
					›
				</Button>
			</HStack>
		</VStack>
	);
}

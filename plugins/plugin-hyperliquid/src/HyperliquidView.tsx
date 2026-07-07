/**
 * HyperliquidView — the single GUI/XR data wrapper for the Hyperliquid surface.
 *
 * It owns the live data (status + markets + the agent's own positions + open
 * orders, plus a background poll via {@link useHyperliquidState}) and renders
 * the one presentational {@link HyperliquidSpatialView} inside a
 * {@link SpatialSurface}. Omitting the `modality` prop lets `SpatialSurface`
 * auto-detect the host surface, so the SAME component serves them all. The
 * view ships GUI-only.
 */

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { dispatchNavigateViewEvent } from "@elizaos/ui/events";
import { useContinuousChatCompactClearanceActive } from "@elizaos/ui/spatial";
import { type CSSProperties, useCallback } from "react";
import {
	type HyperliquidSnapshot,
	HyperliquidSpatialView,
} from "./components/HyperliquidSpatialView.tsx";
import { useHyperliquidState } from "./useHyperliquidState.ts";

/** Return to the apps/home surface via the navigation bus. */
function navigateHome(): void {
	if (typeof window === "undefined") return;
	dispatchNavigateViewEvent({ viewId: "home", viewPath: "/" });
}

const AGENT_HIDDEN_CONTROL_STYLE: CSSProperties = {
	position: "absolute",
	width: 1,
	height: 1,
	margin: -1,
	padding: 0,
	overflow: "hidden",
	clipPath: "inset(50%)",
	whiteSpace: "nowrap",
	border: 0,
};

export function HyperliquidView() {
	const {
		status,
		markets,
		positions,
		orders,
		loading,
		error,
		unavailable,
		refresh,
	} = useHyperliquidState();

	const onAction = useCallback(
		(action: string) => {
			switch (action) {
				case "refresh":
					void refresh();
					return;
				case "back":
					navigateHome();
					return;
			}
		},
		[refresh],
	);

	// The spatial primitives below carry only inert `data-agent-*` markers, so
	// the GUI/XR wrapper registers the view's primary actions with the live
	// agent-surface registry here, reusing the same handlers the spatial view
	// dispatches through `onAction`.
	const refreshControl = useAgentElement<HTMLButtonElement>({
		id: "hyperliquid-refresh",
		role: "button",
		label: "Refresh Hyperliquid",
		group: "hyperliquid",
		description: "Reload Hyperliquid status, markets, positions, and orders",
		status: loading ? "loading" : undefined,
		onActivate: () => {
			void refresh();
		},
	});
	const homeControl = useAgentElement<HTMLButtonElement>({
		id: "hyperliquid-home",
		role: "button",
		label: "Back to home",
		group: "hyperliquid",
		description: "Leave Hyperliquid and return to the home surface",
		onActivate: navigateHome,
	});

	const snapshot: HyperliquidSnapshot = {
		status: {
			publicReadReady: status?.publicReadReady ?? false,
			signerReady: status?.signerReady ?? false,
			executionReady: status?.executionReady ?? false,
			credentialMode: status?.credentialMode ?? "none",
			accountAddress: status?.account.address ?? null,
			vaultReady: status?.vault.ready ?? false,
			executionBlockedReason: status?.executionBlockedReason ?? null,
			vaultGuidance: status?.vault.guidance ?? null,
		},
		markets: markets?.markets ?? [],
		positions: positions?.positions ?? [],
		summary: positions?.summary ?? null,
		orders: orders?.orders ?? [],
		positionsBlockedReason: positions?.readBlockedReason ?? null,
		ordersBlockedReason: orders?.readBlockedReason ?? null,
		unavailable,
		loading,
		error,
	};
	const compactChatClearance = useContinuousChatCompactClearanceActive();

	return (
		<>
			<div aria-hidden="true">
				<button
					ref={refreshControl.ref}
					{...refreshControl.agentProps}
					type="button"
					onClick={() => void refresh()}
					disabled={loading}
					tabIndex={-1}
					style={AGENT_HIDDEN_CONTROL_STYLE}
				/>
				<button
					ref={homeControl.ref}
					{...homeControl.agentProps}
					type="button"
					onClick={navigateHome}
					tabIndex={-1}
					style={AGENT_HIDDEN_CONTROL_STYLE}
				/>
			</div>
			<HyperliquidSpatialView
				snapshot={snapshot}
				onAction={onAction}
				compactChatClearance={compactChatClearance}
			/>
		</>
	);
}

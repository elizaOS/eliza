/**
 * HyperliquidSpatialView - the Hyperliquid dashboard authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus type-only views of
 * the Hyperliquid contracts, so it is safe to render in the Node agent process
 * where the terminal lives (no app-core/React-DOM runtime import).
 */

import {
	Button,
	Card,
	Divider,
	HStack,
	List,
	type SpatialTone,
	Text,
	VStack,
} from "@elizaos/ui/spatial";
import type {
	HyperliquidAccountSummary,
	HyperliquidCredentialMode,
	HyperliquidMarket,
	HyperliquidOrder,
	HyperliquidPosition,
} from "../hyperliquid-contracts.ts";

export interface HyperliquidStatusSnapshot {
	publicReadReady: boolean;
	signerReady: boolean;
	executionReady: boolean;
	credentialMode: HyperliquidCredentialMode;
	accountAddress: string | null;
	vaultReady: boolean;
	executionBlockedReason: string | null;
	/** Vault-connection guidance, shown when the vault is not ready and no local key is set. */
	vaultGuidance?: string | null;
}

export interface HyperliquidSnapshot {
	status: HyperliquidStatusSnapshot;
	markets: HyperliquidMarket[];
	positions: HyperliquidPosition[];
	/** Account margin/value summary; null when the account has no read or never traded. */
	summary?: HyperliquidAccountSummary | null;
	orders: HyperliquidOrder[];
	/** Reason positions are unreadable (e.g. no connected account); null when readable. */
	positionsBlockedReason?: string | null;
	/** Reason orders are unreadable (e.g. no connected account); null when readable. */
	ordersBlockedReason?: string | null;
	/** True when the routes are not mounted on this surface (mobile bundle); shows an unavailable state. */
	unavailable?: boolean;
	loading?: boolean;
	error?: string | null;
}

function credentialModeLabel(mode: HyperliquidCredentialMode): string {
	switch (mode) {
		case "managed_vault":
			return "Managed vault";
		case "local_key":
			return "Local key";
		default:
			return "Read-only";
	}
}

function readinessTone(ready: boolean): SpatialTone {
	return ready ? "success" : "muted";
}

function readinessMark(ready: boolean): string {
	return ready ? "[ok]" : "[--]";
}

function StatusTile({ label, ready }: { label: string; ready: boolean }) {
	return (
		<HStack gap={1} align="center" grow={1}>
			<Text tone={readinessTone(ready)} wrap={false}>
				{readinessMark(ready)}
			</Text>
			<Text bold grow={1} wrap={false}>
				{label}
			</Text>
		</HStack>
	);
}

function shortAddress(address: string | null): string {
	if (!address) return "not configured";
	if (address.length <= 13) return address;
	return `${address.slice(0, 6)}..${address.slice(-4)}`;
}

const EMPTY_CELL = "·";

function toNumber(value: string | number | null | undefined): number | null {
	if (value === null || value === undefined) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** Compact USD ($1.2k / $3.4m) for the account-health strip. Display-only. */
function formatUsdCompact(
	value: number | null,
	options: { withSign?: boolean } = {},
): string {
	if (value === null) return EMPTY_CELL;
	const sign = options.withSign && value > 0 ? "+" : value < 0 ? "-" : "";
	const abs = Math.abs(value);
	if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}m`;
	if (abs >= 1_000)
		return `${sign}$${(abs / 1_000).toFixed(abs >= 100_000 ? 0 : 1)}k`;
	return `${sign}$${abs.toFixed(2)}`;
}

/** Full USD for a position's notional / pnl cell. Display-only. */
function formatUsd(
	value: number | null,
	options: { withSign?: boolean } = {},
): string {
	if (value === null) return EMPTY_CELL;
	const sign = options.withSign && value > 0 ? "+" : value < 0 ? "-" : "";
	const abs = Math.abs(value);
	const body =
		abs >= 1000
			? abs.toLocaleString("en-US", {
					maximumFractionDigits: 2,
					minimumFractionDigits: 2,
				})
			: abs.toFixed(2);
	return `${sign}$${body}`;
}

function formatPrice(value: number | null): string {
	if (value === null) return EMPTY_CELL;
	const abs = Math.abs(value);
	const decimals = abs >= 1000 ? 1 : abs >= 1 ? 2 : 5;
	return value.toLocaleString("en-US", {
		maximumFractionDigits: decimals,
		minimumFractionDigits: decimals,
	});
}

function formatSize(value: string): string {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return value;
	return Math.abs(parsed).toLocaleString("en-US", {
		maximumFractionDigits: 4,
		minimumFractionDigits: 0,
	});
}

function pnlTone(value: number | null): SpatialTone {
	if (value === null || value === 0) return "muted";
	return value > 0 ? "success" : "danger";
}

function isLongPosition(size: string): boolean {
	const parsed = Number(size);
	return Number.isFinite(parsed) ? parsed >= 0 : true;
}

function isOpenPosition(position: HyperliquidPosition): boolean {
	const parsed = Number(position.size);
	return Number.isFinite(parsed) && parsed !== 0;
}

export interface HyperliquidSpatialViewProps {
	snapshot: HyperliquidSnapshot;
	/** Dispatch by agent id: `refresh`, `back`. */
	onAction?: (action: string) => void;
}

export function HyperliquidSpatialView({
	snapshot,
	onAction,
}: HyperliquidSpatialViewProps) {
	const dispatch = (action: string) => () => onAction?.(action);
	const { status } = snapshot;
	const accountReady = Boolean(status.accountAddress);
	const openPositions = snapshot.positions.filter(isOpenPosition);

	if (snapshot.unavailable) {
		return (
			<Card gap={1} padding={1}>
				<Text tone="muted" align="center">
					Unavailable
				</Text>
				<Divider />
				<HStack gap={1} wrap>
					<Button grow={1} agent="refresh" onPress={dispatch("refresh")}>
						Refresh
					</Button>
					<Button
						variant="outline"
						tone="default"
						agent="back"
						onPress={dispatch("back")}
					>
						Back
					</Button>
				</HStack>
			</Card>
		);
	}

	return (
		<Card gap={1} padding={1}>
			<HStack gap={1} align="center">
				<Text
					style="caption"
					tone={status.publicReadReady ? "success" : "danger"}
					grow={1}
				>
					{snapshot.loading
						? "loading"
						: status.publicReadReady
							? "read-ready"
							: "read-blocked"}
				</Text>
				<Text style="caption" tone="muted" wrap={false}>
					{snapshot.markets.length}m / {snapshot.positions.length}p /{" "}
					{snapshot.orders.length}o
				</Text>
			</HStack>

			{snapshot.error ? (
				<Text tone="danger" style="caption">
					{snapshot.error}
				</Text>
			) : null}

			<Divider label="status" />
			<VStack gap={0}>
				<StatusTile label="Reads" ready={status.publicReadReady} />
				<StatusTile
					label={credentialModeLabel(status.credentialMode)}
					ready={status.signerReady}
				/>
				<StatusTile label="Account" ready={accountReady} />
			</VStack>

			{status.executionBlockedReason ? (
				<Text style="caption" tone="warning">
					{status.executionBlockedReason}
				</Text>
			) : null}

			{!status.vaultReady &&
			status.credentialMode !== "local_key" &&
			status.vaultGuidance ? (
				<Text style="caption" tone="muted">
					{status.vaultGuidance}
				</Text>
			) : null}

			<Divider label="markets" />
			{snapshot.markets.length === 0 ? (
				<Text tone="muted" align="center" style="caption">
					None
				</Text>
			) : (
				<List gap={0}>
					{snapshot.markets.slice(0, 12).map((market) => (
						<HStack
							key={market.name}
							gap={1}
							align="center"
							agent={`market-${market.name}`}
						>
							<Text
								bold
								grow={1}
								wrap={false}
								tone={market.isDelisted ? "muted" : "default"}
							>
								{market.name}
							</Text>
							<Text style="caption" tone="primary" wrap={false}>
								{market.maxLeverage ? `${market.maxLeverage}x` : "n/a"}
							</Text>
							<Text style="caption" tone="muted" wrap={false}>
								sz{market.szDecimals}
								{market.onlyIsolated ? " iso" : ""}
							</Text>
						</HStack>
					))}
				</List>
			)}

			<Divider label="account" />
			<HStack gap={1} align="center">
				<Text style="caption" tone="muted" grow={1} wrap={false}>
					{shortAddress(status.accountAddress)}
				</Text>
				<Text
					style="caption"
					tone={status.executionReady ? "success" : "muted"}
					wrap={false}
				>
					{status.executionReady ? "exec-ready" : "exec-off"}
				</Text>
			</HStack>

			{snapshot.summary ? (
				<HStack gap={1} align="center" wrap>
					<Text style="caption" tone="muted" wrap={false}>
						val {formatUsdCompact(toNumber(snapshot.summary.accountValue))}
					</Text>
					<Text style="caption" tone="muted" wrap={false}>
						lev{" "}
						{snapshot.summary.effectiveLeverage === null
							? EMPTY_CELL
							: `${snapshot.summary.effectiveLeverage.toFixed(2)}x`}
					</Text>
					<Text style="caption" tone="muted" wrap={false}>
						wd {formatUsdCompact(toNumber(snapshot.summary.withdrawable))}
					</Text>
					<Text
						style="caption"
						tone={pnlTone(toNumber(snapshot.summary.totalUnrealizedPnl))}
						grow={1}
						align="end"
						wrap={false}
					>
						pnl{" "}
						{formatUsdCompact(toNumber(snapshot.summary.totalUnrealizedPnl), {
							withSign: true,
						})}
					</Text>
				</HStack>
			) : null}

			<Text style="caption" tone="primary">
				positions
			</Text>
			{snapshot.positionsBlockedReason ? (
				<Text style="caption" tone="warning" agent="positions-blocked">
					{snapshot.positionsBlockedReason}
				</Text>
			) : openPositions.length === 0 ? (
				<Text tone="muted" style="caption">
					none
				</Text>
			) : (
				<List gap={0}>
					{openPositions.slice(0, 6).map((position) => {
						const long = isLongPosition(position.size);
						const uPnl = toNumber(position.unrealizedPnl);
						const notional = toNumber(position.positionValue);
						const entry = toNumber(position.entryPx);
						const liq = position.distanceToLiquidationPct;
						return (
							<VStack
								key={position.coin}
								gap={0}
								agent={`position-${position.coin}`}
							>
								<HStack gap={1} align="center">
									<Text bold wrap={false}>
										{position.coin}
									</Text>
									<Text
										style="caption"
										tone={long ? "success" : "danger"}
										wrap={false}
									>
										{long ? "long" : "short"}
									</Text>
									{position.leverageValue !== null ? (
										<Text style="caption" tone="muted" wrap={false}>
											{position.leverageValue}x
										</Text>
									) : null}
									<Text
										style="caption"
										tone={pnlTone(uPnl)}
										grow={1}
										align="end"
										wrap={false}
									>
										{uPnl === null ? "" : formatUsd(uPnl, { withSign: true })}
									</Text>
								</HStack>
								<HStack gap={1} align="center">
									<Text style="caption" tone="muted" grow={1} wrap={false}>
										sz {formatSize(position.size)}
										{notional === null ? "" : ` · ${formatUsd(notional)}`}
										{entry === null ? "" : ` · @${formatPrice(entry)}`}
									</Text>
									{liq === null || liq === undefined ? null : (
										<Text style="caption" tone="warning" wrap={false}>
											{liq.toFixed(0)}% to liq
										</Text>
									)}
								</HStack>
							</VStack>
						);
					})}
				</List>
			)}

			<Text style="caption" tone="primary">
				orders
			</Text>
			{snapshot.ordersBlockedReason ? (
				<Text style="caption" tone="warning" agent="orders-blocked">
					{snapshot.ordersBlockedReason}
				</Text>
			) : snapshot.orders.length === 0 ? (
				<Text tone="muted" style="caption">
					none
				</Text>
			) : (
				<List gap={0}>
					{snapshot.orders.slice(0, 6).map((order) => (
						<HStack
							key={order.oid}
							gap={1}
							align="center"
							agent={`order-${order.oid}`}
						>
							<Text bold wrap={false}>
								{order.coin}
							</Text>
							<Text
								style="caption"
								tone={
									order.side.toLowerCase().startsWith("b")
										? "success"
										: "danger"
								}
								wrap={false}
							>
								{order.side}
							</Text>
							<Text style="caption" tone="muted" grow={1} wrap={false}>
								{order.size} @ {order.limitPx}
							</Text>
							{order.reduceOnly ? (
								<Text style="caption" tone="warning" wrap={false}>
									ro
								</Text>
							) : null}
						</HStack>
					))}
				</List>
			)}

			<Divider />
			<HStack gap={1} wrap>
				<Button grow={1} agent="refresh" onPress={dispatch("refresh")}>
					Refresh
				</Button>
				<Button
					variant="outline"
					tone="default"
					agent="back"
					onPress={dispatch("back")}
				>
					Back
				</Button>
			</HStack>
		</Card>
	);
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBrandConfig } from "../brand-config";
import { getCurrentMainWindowSnapshot } from "../main-window-runtime";
import type { SendToWebview } from "../types.js";

const DEFAULT_PARTITION = getBrandConfig().browserWorkspacePartition;
const DEFAULT_EVAL_TIMEOUT_MS = 30_000;
const MIN_EVAL_TIMEOUT_MS = 1_000;
const MAX_EVAL_TIMEOUT_MS = 5 * 60 * 1_000;
const CONNECTOR_PARTITION_PREFIX = "persist:connector-";
type BrowserWorkspaceTabKind = "internal" | "standard";
type BrowserWorkspaceConnectorAuthState =
	| "unknown"
	| "ready"
	| "auth_pending"
	| "needs_reauth"
	| "manual_handoff";

export interface BrowserWorkspaceTabSnapshot {
	id: string;
	title: string;
	url: string;
	partition: string;
	kind: BrowserWorkspaceTabKind;
	visible: boolean;
	createdAt: string;
	updatedAt: string;
	lastFocusedAt: string | null;
}

interface BrowserWorkspaceTab extends BrowserWorkspaceTabSnapshot {}

export interface OpenBrowserWorkspaceTabOptions {
	url?: string;
	title?: string;
	show?: boolean;
	partition?: string;
	connectorProvider?: string;
	connectorAccountId?: string;
	kind?: BrowserWorkspaceTabKind;
	width?: number;
	height?: number;
}

export interface AcquireBrowserWorkspaceConnectorSessionOptions {
	provider: string;
	accountId: string;
	url?: string;
	title?: string;
	show?: boolean;
	reuse?: boolean;
	authState?: BrowserWorkspaceConnectorAuthState;
	manualHandoffReason?: string | null;
}

export interface BrowserWorkspaceConnectorSessionHandle {
	provider: string;
	accountId: string;
	authState: BrowserWorkspaceConnectorAuthState;
	requiresManualHandoff: boolean;
	sessionRef: {
		kind: "internal-browser";
		handleId: string;
		partition: string;
		tabId: string;
		browser: null;
		companionId: null;
		profileId: null;
		profileLabel: null;
	};
	partition: string;
	tabId: string;
	companionId: null;
	browser: null;
	profileId: null;
	profileLabel: null;
	created: boolean;
	message: string | null;
}

/**
 * Bun-side caller for renderer-owned RPC requests.
 *
 * The renderer holds the live <electrobun-webview> tag refs. When the bridge
 * server (or the agent) needs to evaluate a script in a tab or capture a
 * snapshot, the manager forwards through this caller, which is wired to
 * win.webview.rpc.request.<method> at startup.
 *
 * `getTabRect` returns the tag's bounding rect in CSS pixels relative to the
 * renderer viewport; the manager adds the main-window origin and runs the
 * OS screencapture itself.
 */
export type BrowserWorkspaceRendererCaller = {
	evaluate: (params: {
		id: string;
		script: string;
		timeoutMs: number;
	}) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
	getTabRect: (params: { id: string }) => Promise<{
		x: number;
		y: number;
		width: number;
		height: number;
	} | null>;
};

function toIsoNow(): string {
	return new Date().toISOString();
}

function assertBrowserWorkspaceUrl(url: string): string {
	if (url === "about:blank") {
		return url;
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`browser workspace rejected invalid URL: ${url}`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(
			`browser workspace only supports http/https URLs, got ${parsed.protocol}`,
		);
	}

	return parsed.toString();
}

function normalizeConnectorPartitionSegment(
	value: string,
	fieldName: string,
): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.replace(/-{2,}/g, "-")
		.slice(0, 64);
	if (!normalized) {
		throw new Error(`browser connector session requires ${fieldName}`);
	}
	return normalized;
}

function hashConnectorPartitionKey(provider: string, accountId: string): string {
	const input = `${provider.trim().toLowerCase()}\0${accountId.trim().toLowerCase()}`;
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36).padStart(7, "0");
}

export function resolveBrowserWorkspaceConnectorPartition(
	provider: string,
	accountId: string,
): string {
	const providerSegment = normalizeConnectorPartitionSegment(
		provider,
		"provider",
	);
	const accountSegment = normalizeConnectorPartitionSegment(
		accountId,
		"accountId",
	);
	const suffix = hashConnectorPartitionKey(provider, accountId);
	return `${CONNECTOR_PARTITION_PREFIX}${providerSegment}-${accountSegment}-${suffix}`;
}

function normalizeConnectorAuthState(
	value: BrowserWorkspaceConnectorAuthState | undefined,
	fallback: BrowserWorkspaceConnectorAuthState,
): BrowserWorkspaceConnectorAuthState {
	switch (value) {
		case "unknown":
		case "ready":
		case "auth_pending":
		case "needs_reauth":
		case "manual_handoff":
			return value;
		default:
			return fallback;
	}
}

function requiresManualHandoff(
	state: BrowserWorkspaceConnectorAuthState,
): boolean {
	return (
		state === "auth_pending" ||
		state === "needs_reauth" ||
		state === "manual_handoff"
	);
}

function resolveEvalTimeoutMs(): number {
	const raw = process.env.ELIZA_BROWSER_TAB_EVAL_TIMEOUT_MS?.trim();
	if (!raw) return DEFAULT_EVAL_TIMEOUT_MS;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return DEFAULT_EVAL_TIMEOUT_MS;
	return Math.min(MAX_EVAL_TIMEOUT_MS, Math.max(MIN_EVAL_TIMEOUT_MS, parsed));
}

/**
 * Capture an OS-level PNG of a screen-pixel rectangle and return base64.
 *
 * macOS and Linux screencapture work in points (logical pixels) on Retina
 * displays — same coordinate system as renderer CSS pixels — so callers
 * pass renderer-side coordinates with no DPR multiplication.
 */
async function captureScreenRegionPng(rect: {
	x: number;
	y: number;
	width: number;
	height: number;
}): Promise<{ data: string } | null> {
	if (rect.width <= 0 || rect.height <= 0) return null;

	const x = Math.round(rect.x);
	const y = Math.round(rect.y);
	const width = Math.round(rect.width);
	const height = Math.round(rect.height);

	const tmpPath = path.join(
		os.tmpdir(),
		`${getBrandConfig().urlScheme}-browser-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}.png`,
	);

	let proc: ReturnType<typeof Bun.spawn>;
	try {
		if (process.platform === "darwin") {
			proc = Bun.spawn(
				[
					"screencapture",
					"-x",
					"-R",
					`${x},${y},${width},${height}`,
					"-t",
					"png",
					tmpPath,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
		} else if (process.platform === "win32") {
			const psScript = `
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$gfx.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size)
$gfx.Dispose()
$bmp.Save('${tmpPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`;
			proc = Bun.spawn(["powershell", "-NoProfile", "-Command", psScript], {
				stdout: "pipe",
				stderr: "pipe",
			});
		} else {
			proc = Bun.spawn(
				[
					"import",
					"-window",
					"root",
					"-crop",
					`${width}x${height}+${x}+${y}`,
					tmpPath,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
		}

		await proc.exited;

		if (!fs.existsSync(tmpPath)) return null;

		const buf = fs.readFileSync(tmpPath);
		return buf.length > 100 ? { data: buf.toString("base64") } : null;
	} catch {
		return null;
	} finally {
		try {
			if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
		} catch {
			// best-effort cleanup
		}
	}
}

let browserWorkspaceCounter = 0;

export class BrowserWorkspaceManager {
	private sendToWebview: SendToWebview | null = null;
	private rendererCaller: BrowserWorkspaceRendererCaller | null = null;
	private readonly tabs = new Map<string, BrowserWorkspaceTab>();

	setSendToWebview(fn: SendToWebview | null): void {
		this.sendToWebview = fn;
	}

	setRendererCaller(caller: BrowserWorkspaceRendererCaller | null): void {
		this.rendererCaller = caller;
	}

	private notify(event: string, payload: Record<string, unknown>): void {
		this.sendToWebview?.("browserWorkspaceEvent", { event, ...payload });
	}

	private toSnapshot(tab: BrowserWorkspaceTab): BrowserWorkspaceTabSnapshot {
		return {
			id: tab.id,
			title: tab.title,
			url: tab.url,
			partition: tab.partition,
			kind: tab.kind,
			visible: tab.visible,
			createdAt: tab.createdAt,
			updatedAt: tab.updatedAt,
			lastFocusedAt: tab.lastFocusedAt,
		};
	}

	private getTab(id: string): BrowserWorkspaceTab | null {
		return this.tabs.get(id) ?? null;
	}

	getTabSnapshot(id: string): BrowserWorkspaceTabSnapshot | null {
		const tab = this.getTab(id);
		return tab ? this.toSnapshot(tab) : null;
	}

	async listTabs(): Promise<{ tabs: BrowserWorkspaceTabSnapshot[] }> {
		const tabs = Array.from(this.tabs.values())
			.sort((left, right) => {
				const leftTime = left.lastFocusedAt ?? left.updatedAt;
				const rightTime = right.lastFocusedAt ?? right.updatedAt;
				return (
					rightTime.localeCompare(leftTime) || left.id.localeCompare(right.id)
				);
			})
			.map((tab) => this.toSnapshot(tab));
		return { tabs };
	}

	async openTab(
		options: OpenBrowserWorkspaceTabOptions = {},
	): Promise<BrowserWorkspaceTabSnapshot> {
		const visible = options.show === true;
		const url = assertBrowserWorkspaceUrl(options.url ?? "about:blank");
		const title =
			options.title?.trim() || `${getBrandConfig().appName} Browser`;
		const partition =
			options.partition?.trim() ||
			(options.connectorProvider?.trim() && options.connectorAccountId?.trim()
				? resolveBrowserWorkspaceConnectorPartition(
						options.connectorProvider,
						options.connectorAccountId,
					)
				: DEFAULT_PARTITION);
		const kind: BrowserWorkspaceTabKind =
			options.kind === "internal" ? "internal" : "standard";
		const id = `btab_${++browserWorkspaceCounter}`;
		const createdAt = toIsoNow();

		const tab: BrowserWorkspaceTab = {
			id,
			title,
			url,
			partition,
			kind,
			visible,
			createdAt,
			updatedAt: createdAt,
			lastFocusedAt: visible ? createdAt : null,
		};

		this.tabs.set(id, tab);
		this.notify("opened", { tab: this.toSnapshot(tab) });
		return this.toSnapshot(tab);
	}

	async acquireConnectorSession(
		options: AcquireBrowserWorkspaceConnectorSessionOptions,
	): Promise<BrowserWorkspaceConnectorSessionHandle> {
		const provider = options.provider.trim();
		const accountId = options.accountId.trim();
		if (!provider) {
			throw new Error("browser connector session requires provider");
		}
		if (!accountId) {
			throw new Error("browser connector session requires accountId");
		}

		const partition = resolveBrowserWorkspaceConnectorPartition(
			provider,
			accountId,
		);
		const existing =
			options.reuse === false
				? null
				: (Array.from(this.tabs.values()).find(
						(tab) => tab.partition === partition,
					) ?? null);
		let tab = existing ? this.toSnapshot(existing) : null;
		let created = false;

		if (!tab) {
			tab = await this.openTab({
				kind: "internal",
				partition,
				show: options.show ?? true,
				title: options.title,
				url: options.url,
			});
			created = true;
		} else if (options.show === true) {
			tab = await this.showTab({ id: tab.id });
			if (!tab) {
				throw new Error("browser connector session tab disappeared");
			}
		}

		const authState = normalizeConnectorAuthState(
			options.authState,
			created ? "auth_pending" : "ready",
		);
		const sessionRef = {
			kind: "internal-browser" as const,
			handleId: `internal-browser:${partition}`,
			partition,
			tabId: tab.id,
			browser: null,
			companionId: null,
			profileId: null,
			profileLabel: null,
		};
		return {
			provider,
			accountId,
			authState,
			requiresManualHandoff: requiresManualHandoff(authState),
			sessionRef,
			partition,
			tabId: tab.id,
			companionId: null,
			browser: null,
			profileId: null,
			profileLabel: null,
			created,
			message:
				options.manualHandoffReason ??
				(requiresManualHandoff(authState)
					? "Manual login, MFA, or CAPTCHA may be required in this isolated connector browser session."
					: null),
		};
	}

	async navigateTab(options: {
		id: string;
		url: string;
	}): Promise<BrowserWorkspaceTabSnapshot | null> {
		const tab = this.getTab(options.id);
		if (!tab) return null;

		const nextUrl = assertBrowserWorkspaceUrl(options.url);
		tab.url = nextUrl;
		tab.updatedAt = toIsoNow();
		this.notify("navigated", { tab: this.toSnapshot(tab) });
		return this.toSnapshot(tab);
	}

	async evaluateTab(options: { id: string; script: string }): Promise<unknown> {
		const tab = this.getTab(options.id);
		if (!tab) {
			throw new Error(`browser workspace tab not found: ${options.id}`);
		}
		if (!this.rendererCaller) {
			throw new Error(
				"browser workspace renderer is not attached — eval unavailable",
			);
		}

		const reply = await this.rendererCaller.evaluate({
			id: tab.id,
			script: options.script,
			timeoutMs: resolveEvalTimeoutMs(),
		});
		if (!reply.ok) {
			throw new Error(reply.error ?? "browser workspace tab eval failed");
		}
		return reply.result;
	}

	async snapshotTab(options: { id: string }): Promise<{ data: string } | null> {
		const tab = this.getTab(options.id);
		if (!tab?.visible) return null;
		if (!this.rendererCaller) return null;

		const tabRect = await this.rendererCaller.getTabRect({ id: tab.id });
		if (!tabRect) return null;

		const window = getCurrentMainWindowSnapshot();
		if (!window.bounds) return null;

		return await captureScreenRegionPng({
			x: window.bounds.x + tabRect.x,
			y: window.bounds.y + tabRect.y,
			width: tabRect.width,
			height: tabRect.height,
		});
	}

	async showTab(options: {
		id: string;
	}): Promise<BrowserWorkspaceTabSnapshot | null> {
		const tab = this.getTab(options.id);
		if (!tab) return null;

		tab.visible = true;
		tab.lastFocusedAt = toIsoNow();
		tab.updatedAt = tab.lastFocusedAt;
		this.notify("shown", { tab: this.toSnapshot(tab) });
		return this.toSnapshot(tab);
	}

	async hideTab(options: {
		id: string;
	}): Promise<BrowserWorkspaceTabSnapshot | null> {
		const tab = this.getTab(options.id);
		if (!tab) return null;

		tab.visible = false;
		tab.updatedAt = toIsoNow();
		this.notify("hidden", { tab: this.toSnapshot(tab) });
		return this.toSnapshot(tab);
	}

	async closeTab(options: { id: string }): Promise<boolean> {
		const tab = this.getTab(options.id);
		if (!tab) return false;
		this.tabs.delete(options.id);
		this.notify("closed", { id: tab.id });
		return true;
	}

	dispose(): void {
		this.tabs.clear();
		this.sendToWebview = null;
		this.rendererCaller = null;
	}
}

let browserWorkspaceManager: BrowserWorkspaceManager | null = null;

export function getBrowserWorkspaceManager(): BrowserWorkspaceManager {
	if (!browserWorkspaceManager) {
		browserWorkspaceManager = new BrowserWorkspaceManager();
	}
	return browserWorkspaceManager;
}

export function resetBrowserWorkspaceManagerForTesting(): void {
	browserWorkspaceManager?.dispose();
	browserWorkspaceManager = null;
	browserWorkspaceCounter = 0;
}

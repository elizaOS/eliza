export type BrowserWorkspaceTabKind = "internal" | "standard";

export interface BrowserWorkspaceTab {
	id: string;
	title: string;
	url: string;
	partition: string;
	kind?: BrowserWorkspaceTabKind;
	visible: boolean;
	createdAt: string;
	updatedAt: string;
	lastFocusedAt: string | null;
	liveViewUrl?: string | null;
	interactiveLiveViewUrl?: string | null;
	provider?: string | null;
	status?: string | null;
}

export interface BrowserBridgePageContext {
	id?: string;
	agentId?: string;
	browser?: string;
	profileId?: string;
	windowId?: string;
	tabId?: string;
	url: string | null;
	title?: string | null;
	selectionText?: string | null;
	mainText?: string | null;
	headings?: string[];
	links?: Array<{ text: string; href: string }>;
	forms?: Array<{ action: string | null; fields: string[] }>;
	capturedAt?: string;
	metadata?: Record<string, unknown>;
}

export interface OpenBrowserWorkspaceTabRequest {
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

export interface NavigateBrowserWorkspaceTabRequest {
	id: string;
	url: string;
	partition?: string;
}

export interface EvaluateBrowserWorkspaceTabRequest {
	id: string;
	script: string;
	partition?: string;
}

export interface BrowserWorkspaceHooks {
	closeBrowserWorkspaceTab(
		id: string,
		env?: NodeJS.ProcessEnv,
	): Promise<boolean>;
	evaluateBrowserWorkspaceTab(
		request: EvaluateBrowserWorkspaceTabRequest,
		env?: NodeJS.ProcessEnv,
	): Promise<unknown>;
	isBrowserWorkspaceBridgeConfigured(env?: NodeJS.ProcessEnv): boolean;
	listBrowserWorkspaceTabs(
		env?: NodeJS.ProcessEnv,
	): Promise<BrowserWorkspaceTab[]>;
	navigateBrowserWorkspaceTab(
		request: NavigateBrowserWorkspaceTabRequest,
		env?: NodeJS.ProcessEnv,
	): Promise<BrowserWorkspaceTab>;
	openBrowserWorkspaceTab(
		request: OpenBrowserWorkspaceTabRequest,
		env?: NodeJS.ProcessEnv,
	): Promise<BrowserWorkspaceTab>;
	resolveBrowserWorkspaceConnectorPartition(
		provider: string,
		accountId: string,
	): string;
	showBrowserWorkspaceTab(
		id: string,
		env?: NodeJS.ProcessEnv,
	): Promise<BrowserWorkspaceTab>;
}

const BROWSER_WORKSPACE_HOOKS = Symbol.for("elizaos.browser-workspace.hooks");

type BrowserWorkspaceHooksGlobal = typeof globalThis & {
	[BROWSER_WORKSPACE_HOOKS]?: BrowserWorkspaceHooks;
};

function hooksGlobal(): BrowserWorkspaceHooksGlobal {
	return globalThis as BrowserWorkspaceHooksGlobal;
}

export function registerBrowserWorkspaceHooks(
	hooks: BrowserWorkspaceHooks,
): void {
	hooksGlobal()[BROWSER_WORKSPACE_HOOKS] = hooks;
}

export function getBrowserWorkspaceHooks(): BrowserWorkspaceHooks | null {
	return hooksGlobal()[BROWSER_WORKSPACE_HOOKS] ?? null;
}

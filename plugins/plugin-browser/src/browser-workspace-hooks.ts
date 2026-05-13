import type {
	BrowserWorkspaceTab,
	EvaluateBrowserWorkspaceTabRequest,
	NavigateBrowserWorkspaceTabRequest,
	OpenBrowserWorkspaceTabRequest,
} from "./workspace/browser-workspace-types.js";

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

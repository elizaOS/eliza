/**
 * Browser workspace wallet bridge — hook + pure helpers.
 *
 * Iframes embedded by the browser workspace use window.postMessage to ask the
 * host for wallet state and to request signing / transactions. This hook owns
 * the origin verification, per-tab chain state, request dispatch, and the
 * "ready" broadcast when state changes or an iframe loads.
 *
 * The caller passes in iframe refs, current tabs, and the wallet state it
 * maintains; the hook returns a single `postBrowserWalletReady` function used
 * for per-iframe onLoad and any other point-in-time broadcasts.
 */

import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { BrowserWorkspaceTab } from "../../api";
import {
  BROWSER_WALLET_READY_TYPE,
  BROWSER_WALLET_RESPONSE_TYPE,
  type BrowserWorkspaceWalletRequest,
  type BrowserWorkspaceWalletResponse,
  type BrowserWorkspaceWalletState,
  DEFAULT_BROWSER_WORKSPACE_EVM_CHAIN_ID,
  formatBrowserWorkspaceEvmChainId,
  getUnsupportedBrowserWorkspaceEvmChainError,
  isBrowserWorkspaceEvmChainSupported,
  isBrowserWorkspaceWalletRequest,
  parseBrowserWorkspaceEvmChainId,
} from "./browser-workspace-wallet";

const IFRAME_WALLET_SIGNING_DISABLED_ERROR =
  "Browser wallet signing and transactions are disabled in embedded iframe tabs until wallet consent is available. Open this site in the desktop browser workspace to approve wallet actions.";
const IFRAME_WALLET_CONNECTION_DISABLED_ERROR =
  "Browser wallet account access is disabled in embedded iframe tabs until wallet consent is available. Open this site in the desktop browser workspace to connect a wallet.";
const TYPED_DATA_UNSUPPORTED_ERROR =
  "Typed-data signing is not supported by the Eliza browser wallet.";

// ── Pure helpers ──────────────────────────────────────────────────────

function resolveTargetOrigin(url: string): string | null {
  try {
    const origin = new URL(url).origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

/**
 * Verify a postMessage origin against the tab's known URL.
 *
 * With `allow-same-origin` in the iframe sandbox a malicious page could
 * present the parent's origin. We mitigate by checking the message origin
 * against the URL the user or agent explicitly navigated to; if they don't
 * match we refuse to respond.
 */
export function resolveBrowserWorkspaceMessageOrigin(
  origin: string,
  tabUrl?: string,
): string | null {
  if (!origin || origin === "null") return null;
  if (!tabUrl) return origin;
  try {
    const expectedOrigin = new URL(tabUrl).origin;
    if (!expectedOrigin || expectedOrigin === "null") return null;
    return origin === expectedOrigin ? origin : null;
  } catch {
    return null;
  }
}

export function redactBrowserWorkspaceIframeWalletState(
  state: BrowserWorkspaceWalletState,
): BrowserWorkspaceWalletState {
  return {
    ...state,
    address: null,
    connected: false,
    evmAddress: null,
    evmConnected: false,
    messageSigningAvailable: false,
    transactionSigningAvailable: false,
    chainSwitchingAvailable: false,
    signingAvailable: false,
    solanaAddress: null,
    solanaConnected: false,
    solanaMessageSigningAvailable: false,
    solanaTransactionSigningAvailable: false,
    reason: IFRAME_WALLET_CONNECTION_DISABLED_ERROR,
  };
}

export function normalizeBrowserWorkspaceTxRequest(
  params: unknown,
  fallbackChainId: number,
): {
  broadcast: boolean;
  chainId: number;
  data?: string;
  description?: string;
  to: string;
  value: string;
} | null {
  const raw = Array.isArray(params) && params.length > 0 ? params[0] : params;
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const chainId =
    parseBrowserWorkspaceEvmChainId(value.chainId) ?? fallbackChainId;
  const to = typeof value.to === "string" ? value.to.trim() : "";
  // `value` is optional — ERC-20 / contract calls legitimately omit it.
  const amount =
    typeof value.value === "string"
      ? value.value.trim()
      : typeof value.value === "number"
        ? String(value.value)
        : "0x0";
  if (!to || !chainId || !Number.isFinite(chainId)) return null;
  return {
    broadcast: value.broadcast !== false,
    chainId,
    data: typeof value.data === "string" ? value.data : undefined,
    description:
      typeof value.description === "string" ? value.description : undefined,
    to,
    value: amount,
  };
}

// ── Request dispatch ──────────────────────────────────────────────────

type HandlerResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

export type BrowserWorkspaceWalletHandlerResult = HandlerResult;

export interface BrowserWorkspaceWalletHandlerContext {
  sourceTab: BrowserWorkspaceTab;
  walletState: BrowserWorkspaceWalletState;
  tabChainId: number;
  setTabChainId: (chainId: number) => void;
  loadWalletState: () => Promise<BrowserWorkspaceWalletState>;
  postWalletReady: (
    tab: BrowserWorkspaceTab,
    state: BrowserWorkspaceWalletState,
  ) => void;
  walletStateRef: RefObject<BrowserWorkspaceWalletState>;
}

export async function dispatchBrowserWorkspaceWalletRequest(
  request: BrowserWorkspaceWalletRequest,
  ctx: BrowserWorkspaceWalletHandlerContext,
): Promise<HandlerResult> {
  const { walletState } = ctx;

  switch (request.method) {
    case "getState":
      return {
        ok: true,
        result: redactBrowserWorkspaceIframeWalletState(walletState),
      };

    case "requestAccounts":
      return { ok: false, error: IFRAME_WALLET_CONNECTION_DISABLED_ERROR };

    case "eth_accounts":
      return { ok: true, result: [] };

    case "eth_requestAccounts":
      return { ok: false, error: IFRAME_WALLET_CONNECTION_DISABLED_ERROR };

    case "eth_chainId":
      return {
        ok: true,
        result: formatBrowserWorkspaceEvmChainId(ctx.tabChainId),
      };

    case "solana_connect":
      return { ok: false, error: IFRAME_WALLET_CONNECTION_DISABLED_ERROR };

    case "solana_signMessage":
      return { ok: false, error: IFRAME_WALLET_SIGNING_DISABLED_ERROR };

    case "solana_signTransaction":
      return { ok: false, error: IFRAME_WALLET_SIGNING_DISABLED_ERROR };

    case "solana_signAndSendTransaction":
      return { ok: false, error: IFRAME_WALLET_SIGNING_DISABLED_ERROR };

    case "wallet_switchEthereumChain":
      return handleSwitchChain(request.params, ctx);

    case "personal_sign":
    case "eth_sign":
      return { ok: false, error: IFRAME_WALLET_SIGNING_DISABLED_ERROR };

    case "eth_signTypedData":
    case "eth_signTypedData_v3":
    case "eth_signTypedData_v4":
      return { ok: false, error: TYPED_DATA_UNSUPPORTED_ERROR };

    case "sendTransaction":
    case "eth_sendTransaction":
      return { ok: false, error: IFRAME_WALLET_SIGNING_DISABLED_ERROR };

    default:
      return { ok: false, error: "Unsupported browser wallet request." };
  }
}

function handleSwitchChain(
  params: unknown,
  ctx: BrowserWorkspaceWalletHandlerContext,
): HandlerResult {
  if (!ctx.walletState.chainSwitchingAvailable) {
    return {
      ok: false,
      error:
        ctx.walletState.reason ||
        "Browser wallet chain switching is unavailable.",
    };
  }
  const rawChainId = Array.isArray(params)
    ? (params[0] as { chainId?: unknown } | undefined)?.chainId
    : (params as { chainId?: unknown } | undefined)?.chainId;
  const nextChainId = parseBrowserWorkspaceEvmChainId(rawChainId);
  if (!nextChainId) {
    return {
      ok: false,
      error: "wallet_switchEthereumChain requires a valid chainId.",
    };
  }
  if (!isBrowserWorkspaceEvmChainSupported(nextChainId)) {
    return {
      ok: false,
      error: getUnsupportedBrowserWorkspaceEvmChainError(nextChainId),
    };
  }
  ctx.setTabChainId(nextChainId);
  // Use the ref (not the stale closure) so the dApp sees the most
  // up-to-date wallet state after the chain switch.
  ctx.postWalletReady(ctx.sourceTab, ctx.walletStateRef.current);
  return { ok: true, result: null };
}

// ── Hook ──────────────────────────────────────────────────────────────

interface UseBrowserWorkspaceWalletBridgeOptions {
  iframeRefs: RefObject<Map<string, HTMLIFrameElement | null>>;
  workspaceTabs: BrowserWorkspaceTab[];
  walletState: BrowserWorkspaceWalletState;
  loadWalletState: () => Promise<BrowserWorkspaceWalletState>;
}

export function useBrowserWorkspaceWalletBridge({
  iframeRefs,
  workspaceTabs,
  walletState,
  loadWalletState,
}: UseBrowserWorkspaceWalletBridgeOptions): {
  postBrowserWalletReady: (
    tab: BrowserWorkspaceTab,
    state: BrowserWorkspaceWalletState,
  ) => void;
} {
  const walletStateRef = useRef(walletState);
  const workspaceTabsRef = useRef(workspaceTabs);
  const chainIdByTabRef = useRef(new Map<string, number>());
  walletStateRef.current = walletState;
  workspaceTabsRef.current = workspaceTabs;

  const postBrowserWalletReady = useCallback(
    (tab: BrowserWorkspaceTab, state: BrowserWorkspaceWalletState) => {
      const iframeWindow = iframeRefs.current?.get(tab.id)?.contentWindow;
      const targetOrigin = resolveTargetOrigin(tab.url);
      if (!iframeWindow || !targetOrigin) return;
      iframeWindow.postMessage(
        {
          type: BROWSER_WALLET_READY_TYPE,
          state: redactBrowserWorkspaceIframeWalletState(state),
        },
        targetOrigin,
      );
    },
    [iframeRefs],
  );

  // Broadcast fresh state to every loaded iframe whenever the wallet state
  // changes — so dApps see connection and chain updates without polling.
  useEffect(() => {
    for (const tab of workspaceTabs) {
      postBrowserWalletReady(tab, walletState);
    }
  }, [walletState, postBrowserWalletReady, workspaceTabs]);

  // Drop per-tab chain overrides for tabs that have closed.
  useEffect(() => {
    const knownTabIds = new Set(workspaceTabs.map((tab) => tab.id));
    for (const tabId of chainIdByTabRef.current.keys()) {
      if (!knownTabIds.has(tabId)) {
        chainIdByTabRef.current.delete(tabId);
      }
    }
  }, [workspaceTabs]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      if (!isBrowserWorkspaceWalletRequest(event.data)) return;
      const request = event.data;

      const sourceTab = workspaceTabsRef.current.find(
        (tab) =>
          iframeRefs.current?.get(tab.id)?.contentWindow === event.source,
      );
      const sourceWindow = sourceTab
        ? iframeRefs.current?.get(sourceTab.id)?.contentWindow
        : null;
      if (!sourceTab || !sourceWindow) return;

      const targetOrigin = resolveBrowserWorkspaceMessageOrigin(
        event.origin,
        sourceTab.url,
      );
      if (targetOrigin === null) return;

      const respond = (response: BrowserWorkspaceWalletResponse) => {
        sourceWindow.postMessage(response, targetOrigin);
      };

      void (async () => {
        const ctx: BrowserWorkspaceWalletHandlerContext = {
          sourceTab,
          walletState: walletStateRef.current,
          tabChainId:
            chainIdByTabRef.current.get(sourceTab.id) ??
            DEFAULT_BROWSER_WORKSPACE_EVM_CHAIN_ID,
          setTabChainId: (chainId) =>
            chainIdByTabRef.current.set(sourceTab.id, chainId),
          loadWalletState,
          postWalletReady: postBrowserWalletReady,
          walletStateRef,
        };
        const result = await dispatchBrowserWorkspaceWalletRequest(
          request,
          ctx,
        );
        respond({
          type: BROWSER_WALLET_RESPONSE_TYPE,
          requestId: request.requestId,
          ...result,
        });
      })();
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [iframeRefs, loadWalletState, postBrowserWalletReady]);

  return { postBrowserWalletReady };
}

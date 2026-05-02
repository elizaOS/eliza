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
import { type BrowserWorkspaceTab, client } from "../../api";
import {
  BROWSER_WALLET_READY_TYPE,
  BROWSER_WALLET_RESPONSE_TYPE,
  type BrowserWorkspaceWalletRequest,
  type BrowserWorkspaceWalletResponse,
  type BrowserWorkspaceWalletState,
  isBrowserWorkspaceWalletRequest,
} from "./browser-workspace-wallet";

const DEFAULT_CHAIN_ID = 1;

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

function formatChainId(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

function parseChainId(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = trimmed.startsWith("0x")
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function resolveAccounts(state: BrowserWorkspaceWalletState): string[] {
  return state.evmAddress ? [state.evmAddress] : [];
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
  const chainId = parseChainId(value.chainId) ?? fallbackChainId;
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

function resolveMessageToSign(
  params: unknown,
  address: string | null,
): string | null {
  if (typeof params === "string") return params;
  if (!Array.isArray(params) || params.length === 0) return null;
  const [first, second] = params;
  if (typeof first === "string" && typeof second === "string" && address) {
    if (first.toLowerCase() === address.toLowerCase()) return second;
    if (second.toLowerCase() === address.toLowerCase()) return first;
  }
  return typeof first === "string" ? first : null;
}

// ── Request dispatch ──────────────────────────────────────────────────

type HandlerResult =
  | { ok: true; result: unknown }
  | { ok: false; error: string };

interface HandlerContext {
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

async function dispatch(
  request: BrowserWorkspaceWalletRequest,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  const { walletState } = ctx;

  switch (request.method) {
    case "getState":
      return { ok: true, result: walletState };

    case "requestAccounts":
      return { ok: true, result: { accounts: resolveAccounts(walletState) } };

    case "eth_accounts":
    case "eth_requestAccounts":
      return { ok: true, result: resolveAccounts(walletState) };

    case "eth_chainId":
      return { ok: true, result: formatChainId(ctx.tabChainId) };

    case "solana_connect":
      if (!walletState.solanaConnected || !walletState.solanaAddress) {
        return { ok: false, error: "Solana wallet is unavailable." };
      }
      return { ok: true, result: { address: walletState.solanaAddress } };

    case "solana_signMessage":
      return handleSolanaSignMessage(request.params, walletState);

    case "solana_signTransaction":
      return handleSolanaSendTransaction(request.params, walletState, false);

    case "solana_signAndSendTransaction":
      return handleSolanaSendTransaction(request.params, walletState, true);

    case "wallet_switchEthereumChain":
      return handleSwitchChain(request.params, ctx);

    case "personal_sign":
    case "eth_sign":
      return handleEthSign(request.params, walletState);

    case "sendTransaction":
    case "eth_sendTransaction":
      return handleSendTransaction(request, ctx);

    default:
      return { ok: false, error: "Unsupported browser wallet request." };
  }
}

async function handleSolanaSendTransaction(
  params: unknown,
  walletState: BrowserWorkspaceWalletState,
  broadcast: boolean,
): Promise<HandlerResult> {
  if (!walletState.solanaTransactionSigningAvailable) {
    return {
      ok: false,
      error:
        walletState.reason ||
        "Solana browser wallet transaction signing is unavailable.",
    };
  }
  const p =
    params && typeof params === "object"
      ? (params as {
          transactionBase64?: unknown;
          cluster?: unknown;
          description?: unknown;
        })
      : null;
  const transactionBase64 =
    typeof p?.transactionBase64 === "string" ? p.transactionBase64 : null;
  if (!transactionBase64) {
    return {
      ok: false,
      error:
        "Solana browser wallet transaction signing requires transactionBase64.",
    };
  }
  const cluster =
    p?.cluster === "devnet" ||
    p?.cluster === "testnet" ||
    p?.cluster === "mainnet"
      ? p.cluster
      : undefined;
  const description =
    typeof p?.description === "string" ? p.description : undefined;
  try {
    const result = await client.sendBrowserSolanaTransaction({
      transactionBase64,
      broadcast,
      ...(cluster ? { cluster } : {}),
      ...(description ? { description } : {}),
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function handleSolanaSignMessage(
  params: unknown,
  walletState: BrowserWorkspaceWalletState,
): Promise<HandlerResult> {
  if (!walletState.solanaMessageSigningAvailable) {
    return {
      ok: false,
      error:
        walletState.reason || "Solana browser wallet signing is unavailable.",
    };
  }
  const p =
    params && typeof params === "object"
      ? (params as { message?: unknown; messageBase64?: unknown })
      : null;
  const message = typeof p?.message === "string" ? p.message : undefined;
  const messageBase64 =
    typeof p?.messageBase64 === "string" ? p.messageBase64 : undefined;
  if (!message && !messageBase64) {
    return {
      ok: false,
      error: "Solana browser wallet signing requires message or messageBase64.",
    };
  }
  try {
    const result = await client.signBrowserSolanaMessage({
      ...(message ? { message } : {}),
      ...(messageBase64 ? { messageBase64 } : {}),
    });
    return { ok: true, result };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function handleSwitchChain(
  params: unknown,
  ctx: HandlerContext,
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
  const nextChainId = parseChainId(rawChainId);
  if (!nextChainId) {
    return {
      ok: false,
      error: "wallet_switchEthereumChain requires a valid chainId.",
    };
  }
  ctx.setTabChainId(nextChainId);
  // Use the ref (not the stale closure) so the dApp sees the most
  // up-to-date wallet state after the chain switch.
  ctx.postWalletReady(ctx.sourceTab, ctx.walletStateRef.current);
  return { ok: true, result: null };
}

async function handleEthSign(
  params: unknown,
  walletState: BrowserWorkspaceWalletState,
): Promise<HandlerResult> {
  if (!walletState.messageSigningAvailable) {
    return {
      ok: false,
      error:
        walletState.mode === "steward"
          ? "Browser message signing requires a local wallet key."
          : walletState.reason ||
            "Browser wallet message signing is unavailable.",
    };
  }
  const message = resolveMessageToSign(params, walletState.address);
  if (!message) {
    return {
      ok: false,
      error: "Browser wallet signing requires a message payload.",
    };
  }
  try {
    const result = await client.signBrowserWalletMessage(message);
    // personal_sign / eth_sign expect the signature string directly.
    return { ok: true, result: result.signature };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

async function handleSendTransaction(
  request: BrowserWorkspaceWalletRequest,
  ctx: HandlerContext,
): Promise<HandlerResult> {
  if (!ctx.walletState.transactionSigningAvailable) {
    return {
      ok: false,
      error:
        ctx.walletState.reason ||
        "Browser wallet transaction signing is unavailable.",
    };
  }
  const transaction = normalizeBrowserWorkspaceTxRequest(
    request.params,
    ctx.tabChainId,
  );
  if (!transaction) {
    return {
      ok: false,
      error: "Browser wallet sendTransaction requires to, value, and chainId.",
    };
  }
  try {
    const result = await client.sendBrowserWalletTransaction(transaction);
    const nextState = await ctx.loadWalletState();
    ctx.postWalletReady(ctx.sourceTab, nextState);
    // eth_sendTransaction expects the tx hash string; `sendTransaction`
    // (Eliza flavor) returns the full result.
    return {
      ok: true,
      result:
        request.method === "eth_sendTransaction"
          ? (result.txHash ?? result.txId ?? null)
          : result,
    };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        { type: BROWSER_WALLET_READY_TYPE, state },
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
        const ctx: HandlerContext = {
          sourceTab,
          walletState: walletStateRef.current,
          tabChainId:
            chainIdByTabRef.current.get(sourceTab.id) ?? DEFAULT_CHAIN_ID,
          setTabChainId: (chainId) =>
            chainIdByTabRef.current.set(sourceTab.id, chainId),
          loadWalletState,
          postWalletReady: postBrowserWalletReady,
          walletStateRef,
        };
        const result = await dispatch(request, ctx);
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

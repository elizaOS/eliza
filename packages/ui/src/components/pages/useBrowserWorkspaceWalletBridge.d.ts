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
import { type RefObject } from "react";
import type { BrowserWorkspaceTab } from "../../api";
import {
  type BrowserWorkspaceWalletRequest,
  type BrowserWorkspaceWalletState,
} from "./browser-workspace-wallet";
/**
 * Verify a postMessage origin against the tab's known URL.
 *
 * With `allow-same-origin` in the iframe sandbox a malicious page could
 * present the parent's origin. We mitigate by checking the message origin
 * against the URL the user or agent explicitly navigated to; if they don't
 * match we refuse to respond.
 */
export declare function resolveBrowserWorkspaceMessageOrigin(
  origin: string,
  tabUrl?: string,
): string | null;
export declare function redactBrowserWorkspaceIframeWalletState(
  state: BrowserWorkspaceWalletState,
): BrowserWorkspaceWalletState;
export declare function normalizeBrowserWorkspaceTxRequest(
  params: unknown,
  fallbackChainId: number,
): {
  broadcast: boolean;
  chainId: number;
  data?: string;
  description?: string;
  to: string;
  value: string;
} | null;
type HandlerResult =
  | {
      ok: true;
      result: unknown;
    }
  | {
      ok: false;
      error: string;
    };
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
export declare function dispatchBrowserWorkspaceWalletRequest(
  request: BrowserWorkspaceWalletRequest,
  ctx: BrowserWorkspaceWalletHandlerContext,
): Promise<HandlerResult>;
interface UseBrowserWorkspaceWalletBridgeOptions {
  iframeRefs: RefObject<Map<string, HTMLIFrameElement | null>>;
  workspaceTabs: BrowserWorkspaceTab[];
  walletState: BrowserWorkspaceWalletState;
  loadWalletState: () => Promise<BrowserWorkspaceWalletState>;
}
export declare function useBrowserWorkspaceWalletBridge({
  iframeRefs,
  workspaceTabs,
  walletState,
  loadWalletState,
}: UseBrowserWorkspaceWalletBridgeOptions): {
  postBrowserWalletReady: (
    tab: BrowserWorkspaceTab,
    state: BrowserWorkspaceWalletState,
  ) => void;
};
//# sourceMappingURL=useBrowserWorkspaceWalletBridge.d.ts.map

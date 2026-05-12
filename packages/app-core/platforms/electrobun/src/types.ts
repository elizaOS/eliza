/**
 * Shared types used across electrobun native modules and bridges.
 */

/** Callback to send a JSON‑serialisable message to the renderer webview. */
export type SendToWebview = (message: string, payload?: unknown) => void;

/** Minimal subset of the electrobun RPC that exposes JS evaluation on a webview. */
export type WebviewEvalRpc = {
	requestProxy?: {
		evaluateJavascriptWithResponse?: (params: {
			script: string;
		}) => Promise<unknown>;
	};
};

/** Listener for incoming RPC messages from the webview. */
export type RpcMessageListener = (payload: unknown) => void;

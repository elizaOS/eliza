/**
 * AgentRequestTransport for the desktop-hosted local agent: dispatches requests
 * over the Electrobun renderer RPC to the in-process agent via its IPC base.
 */

import { getElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import {
  isMobileLocalAgentIpcUrl,
  mobileLocalAgentPathFromUrl,
} from "../first-run/mobile-runtime-mode";
import {
  type AgentRequestTransport,
  bodyToString,
  headersToRecord,
  isStreamingRequest,
  methodAllowsBody,
} from "./transport";

/**
 * Desktop (Electrobun) local-agent transport (#12180).
 *
 * When the desktop app runs the on-device agent over native IPC, the renderer's
 * API base is the `eliza-local-agent://ipc` scheme (the same identity the mobile
 * platforms already use) rather than `http://127.0.0.1:<port>`. Requests to that
 * base must not open a socket — they route through the Electrobun main process
 * over `window.__ELIZA_ELECTROBUN_RPC__.request.localAgentRequest(...)`, which
 * drives the in-process route kernel (stdio bridge) with no TCP listener.
 */

interface DesktopLocalAgentRequestResult {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

async function requestDesktopStream(
  rpc: NonNullable<ReturnType<typeof getElectrobunRendererRpc>>,
  url: string,
  init: RequestInit,
  method: string,
  body: string | null | undefined,
): Promise<Response> {
  const requestStream = rpc.request.localAgentStreamRequest;
  if (!requestStream) {
    throw new Error("Desktop local-agent streaming RPC is not registered");
  }
  const streamId = crypto.randomUUID();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let detached = false;
  const encoder = new TextEncoder();
  const detach = (): void => {
    if (detached) return;
    detached = true;
    rpc.offMessage("localAgentStreamChunk", onChunk);
    rpc.offMessage("localAgentStreamEnd", onEnd);
    init.signal?.removeEventListener("abort", onAbort);
  };
  const cancel = (): void => {
    void rpc.request.localAgentCancelRequest({ requestId: streamId });
  };
  const onChunk = (payload: unknown): void => {
    const event = payload as { streamId?: string; chunk?: string };
    if (event.streamId !== streamId || typeof event.chunk !== "string") return;
    controller?.enqueue(encoder.encode(event.chunk));
  };
  const onEnd = (payload: unknown): void => {
    const event = payload as { streamId?: string; error?: string };
    if (event.streamId !== streamId) return;
    if (event.error) controller?.error(new Error(event.error));
    else controller?.close();
    detach();
  };
  const onAbort = (): void => {
    cancel();
    controller?.error(
      init.signal?.reason instanceof Error
        ? init.signal.reason
        : new DOMException(
            "Desktop local-agent stream cancelled",
            "AbortError",
          ),
    );
    detach();
  };
  const responseBody = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
    cancel() {
      cancel();
      detach();
    },
  });
  rpc.onMessage("localAgentStreamChunk", onChunk);
  rpc.onMessage("localAgentStreamEnd", onEnd);
  init.signal?.addEventListener("abort", onAbort, { once: true });
  if (init.signal?.aborted) {
    onAbort();
    throw init.signal.reason instanceof Error
      ? init.signal.reason
      : new DOMException("Desktop local-agent stream cancelled", "AbortError");
  }
  try {
    const head = (await requestStream.call(rpc.request, {
      streamId,
      path: mobileLocalAgentPathFromUrl(url) ?? url,
      method,
      headers: headersToRecord(init.headers),
      body: methodAllowsBody(method) ? (body ?? null) : null,
    })) as {
      status: number;
      statusText?: string;
      headers?: Record<string, string>;
    };
    return new Response(responseBody, {
      status: head.status,
      statusText: head.statusText ?? "",
      headers: head.headers,
    });
  } catch (error) {
    detach();
    throw error;
  }
}

/**
 * True when `url` targets the desktop local-agent IPC base under an Electrobun
 * runtime. Mirrors `isMobileLocalAgentIpcUrl` (same `eliza-local-agent://ipc`
 * scheme), gated to Electrobun so mobile IPC URLs never resolve here.
 */
export function isElectrobunLocalMode(url: string): boolean {
  return isElectrobunRuntime() && isMobileLocalAgentIpcUrl(url);
}

const desktopLocalAgentTransport: AgentRequestTransport = {
  async request(url, init) {
    const rpc = getElectrobunRendererRpc();
    const request = rpc?.request?.localAgentRequest;
    if (!request || !rpc?.request) {
      // The IPC base is active but the main-process handler is not wired yet.
      // Fail loudly — falling back to fetch would open a socket the whole
      // feature exists to remove.
      throw new Error(
        "Desktop local-agent IPC transport is not available: window.__ELIZA_ELECTROBUN_RPC__.request.localAgentRequest is not registered",
      );
    }

    const method = init.method ?? "GET";
    const body = bodyToString(init.body);
    if (isStreamingRequest(url, init.headers)) {
      return requestDesktopStream(rpc, url, init, method, body);
    }
    const requestId = crypto.randomUUID();
    const requestPromise = request.call(rpc.request, {
      requestId,
      // The path relative to the IPC base; the main process joins it to the
      // in-process route kernel. Fall back to the raw url if it is not an IPC
      // URL (should not happen — the resolver gates on isElectrobunLocalMode).
      path: mobileLocalAgentPathFromUrl(url) ?? url,
      method,
      headers: headersToRecord(init.headers),
      body: methodAllowsBody(method) ? (body ?? null) : null,
    }) as Promise<DesktopLocalAgentRequestResult>;
    const result = await new Promise<DesktopLocalAgentRequestResult>(
      (resolve, reject) => {
        const onAbort = (): void => {
          void rpc.request.localAgentCancelRequest({ requestId });
          reject(
            init.signal?.reason instanceof Error
              ? init.signal.reason
              : new DOMException(
                  "Desktop local-agent request cancelled",
                  "AbortError",
                ),
          );
        };
        if (init.signal?.aborted) {
          onAbort();
          return;
        }
        init.signal?.addEventListener("abort", onAbort, { once: true });
        void requestPromise.then(
          (value) => {
            init.signal?.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error) => {
            init.signal?.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      },
    );

    return new Response(result.body ?? "", {
      status: result.status,
      statusText: result.statusText ?? "",
      headers: result.headers,
    });
  },
};

export function desktopLocalAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  return Promise.resolve(
    isElectrobunLocalMode(url) ? desktopLocalAgentTransport : null,
  );
}

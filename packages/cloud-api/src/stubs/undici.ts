/**
 * undici — Cloudflare Workers compatibility shim.
 *
 * The real undici is Node's fetch implementation; it imports `node:net`,
 * `node:perf_hooks`, `MessagePort`, etc. that don't exist on the Workers
 * runtime. Workers have native `fetch`, `Request`, `Response`, `Headers`,
 * `FormData`, `URL`, `URLSearchParams` — re-export those so any
 * transitive `import { fetch, Headers } from "undici"` resolves cleanly.
 */

export const fetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis);
export const Request = globalThis.Request;
export const Response = globalThis.Response;
export const Headers = globalThis.Headers;
export const FormData = globalThis.FormData;
export const File = globalThis.File;
export const Blob = globalThis.Blob;
export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;
export const WebSocket = globalThis.WebSocket;
export const CloseEvent = globalThis.CloseEvent;
export const MessageEvent = globalThis.MessageEvent;
export const EventSource = globalThis.EventSource;
export const ReadableStream = globalThis.ReadableStream;
export const WritableStream = globalThis.WritableStream;
export const TransformStream = globalThis.TransformStream;

const NOT_AVAILABLE =
  "undici advanced features (Agent / Pool / Dispatcher / interceptors) are not available on Cloudflare Workers — use the global `fetch` directly.";

class WorkerUnavailableCtor {
  constructor() {
    throw new Error(NOT_AVAILABLE);
  }
}

export const Agent = WorkerUnavailableCtor;
export const Pool = WorkerUnavailableCtor;
export const Dispatcher = WorkerUnavailableCtor;
export const ProxyAgent = WorkerUnavailableCtor;
export const MockAgent = WorkerUnavailableCtor;
export const MockPool = WorkerUnavailableCtor;
export const Client = WorkerUnavailableCtor;
export const BalancedPool = WorkerUnavailableCtor;
export const RetryAgent = WorkerUnavailableCtor;
export const EnvHttpProxyAgent = WorkerUnavailableCtor;
export const setGlobalDispatcher = () => {};
export const getGlobalDispatcher = () => {
  throw new Error(NOT_AVAILABLE);
};
export const setGlobalOrigin = () => {};
export const getGlobalOrigin = () => undefined;

export default {
  fetch,
  Request,
  Response,
  Headers,
  FormData,
  File,
  Blob,
  URL,
  URLSearchParams,
  Agent,
  Pool,
  Dispatcher,
  ProxyAgent,
  MockAgent,
  MockPool,
  Client,
  BalancedPool,
  RetryAgent,
  EnvHttpProxyAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  setGlobalOrigin,
  getGlobalOrigin,
};

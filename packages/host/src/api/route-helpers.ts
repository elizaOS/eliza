/**
 * Route-context and helper interfaces shared by the HTTP dispatch layer: the
 * request/response metadata plus the `json` / `error` / `readJsonBody`
 * responders threaded into each route handler. Type-only; the implementations
 * live in `http-helpers.ts`.
 */
import type http from "node:http";

export interface RouteRequestMeta {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
}

export interface RouteHelpers {
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
}

export interface RouteRequestContext extends RouteRequestMeta, RouteHelpers {}

export interface AppPackageRouteContext
  extends RouteRequestMeta,
    Pick<RouteHelpers, "error" | "json"> {
  url: URL;
  runtime: unknown | null;
  readJsonBody: <T extends object = Record<string, unknown>>(
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
}

export interface AppPackageRouteDispatchContext extends RouteRequestContext {
  url: URL;
  runtime: unknown | null;
}

export interface RequestBodyOptions {
  /** Maximum accepted body size in bytes. */
  maxBytes?: number;
  /** String conversion encoding for body text helpers. */
  encoding?: BufferEncoding;
  /** Error message returned when the request body exceeds `maxBytes`. */
  tooLargeMessage?: string;
  /** When true, resolves to `null` instead of rejecting on body read failure. */
  returnNullOnError?: boolean;
  /** When true, resolves to `null` instead of rejecting on size limit exceed. */
  returnNullOnTooLarge?: boolean;
  /** Whether to destroy the request stream as soon as the body limit is exceeded. */
  destroyOnTooLarge?: boolean;
}

export interface ReadTextBodyOptions extends RequestBodyOptions {
  /** Optional response-timeout behavior handled by caller; kept for parity with legacy wrappers. */
}

export interface ReadJsonBodyOptions extends ReadTextBodyOptions {
  /** Whether to require JSON object shape (not arrays/null). */
  requireObject?: boolean;
  /** Response status used for parse/read failures. */
  readErrorStatus?: number;
  /** Response status used for non-object body when `requireObject` is true. */
  nonObjectStatus?: number;
  /** Response status used for invalid JSON syntax. */
  parseErrorStatus?: number;
  /** Override for read errors (including size / stream errors). */
  readErrorMessage?: string;
  /** Override when JSON is valid but not an object. */
  nonObjectMessage?: string;
  /** Override for malformed JSON parse errors. */
  parseErrorMessage?: string;
}

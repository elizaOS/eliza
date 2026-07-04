/**
 * Route-context and helper interfaces shared by the HTTP dispatch layer: the
 * request/response metadata plus the `json` / `error` / `readJsonBody`
 * responders threaded into each route handler. Type-only; the implementations
 * live in `http-helpers.ts`.
 */
import type http from "node:http";
import type { ReadJsonBodyOptions } from "./http-helpers.js";

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

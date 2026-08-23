/**
 * Pins the compile-time contracts shared by core route dispatchers, including
 * request metadata, helper signatures, and the two app-package context shapes.
 */
import type http from "node:http";
import { describe, expectTypeOf, it } from "vitest";
import type { ReadJsonBodyOptions } from "./http-helpers.js";
import type {
	AppPackageRouteContext,
	AppPackageRouteDispatchContext,
	RouteHelpers,
	RouteRequestContext,
	RouteRequestMeta,
} from "./route-helpers.js";

interface ExpectedRouteRequestMeta {
	req: http.IncomingMessage;
	res: http.ServerResponse;
	method: string;
	pathname: string;
}

interface ExpectedRouteHelpers {
	json: (res: http.ServerResponse, data: unknown, status?: number) => void;
	error: (res: http.ServerResponse, message: string, status?: number) => void;
	readJsonBody: <T extends object>(
		req: http.IncomingMessage,
		res: http.ServerResponse,
		options?: ReadJsonBodyOptions,
	) => Promise<T | null>;
}

describe("route helper contracts", () => {
	it("exposes the request and response metadata used for route matching", () => {
		expectTypeOf<RouteRequestMeta>().toEqualTypeOf<ExpectedRouteRequestMeta>();
	});

	it("preserves responder status arguments and the generic body reader", () => {
		expectTypeOf<RouteHelpers>().toEqualTypeOf<ExpectedRouteHelpers>();
	});

	it("combines request metadata with every shared route helper", () => {
		expectTypeOf<RouteRequestContext>().toEqualTypeOf<
			ExpectedRouteRequestMeta & ExpectedRouteHelpers
		>();
	});

	it("binds app-package body reads while retaining JSON and error responders", () => {
		expectTypeOf<AppPackageRouteContext>().toEqualTypeOf<
			ExpectedRouteRequestMeta & {
				url: URL;
				runtime: unknown | null;
				json: ExpectedRouteHelpers["json"];
				error: ExpectedRouteHelpers["error"];
				readJsonBody: <T extends object = Record<string, unknown>>(
					options?: ReadJsonBodyOptions,
				) => Promise<T | null>;
			}
		>();
	});

	it("extends the full dispatch context with URL and nullable runtime state", () => {
		expectTypeOf<AppPackageRouteDispatchContext>().toEqualTypeOf<
			ExpectedRouteRequestMeta &
				ExpectedRouteHelpers & {
					url: URL;
					runtime: unknown | null;
				}
		>();
	});
});

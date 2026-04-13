import type { IncomingMessage, ServerResponse } from "node:http";
import { createMockHttpResponse } from "./test-helpers.js";

export type RouteBody = Record<string, unknown>;

export type RouteInvocationResult<TPayload = unknown> = {
  handled: boolean;
  status: number;
  payload: TPayload;
};

export type RouteInvokeArgs<TBody = RouteBody, TRuntime = unknown> = {
  method: string;
  pathname: string;
  url?: string;
  body?: TBody | null;
  runtimeOverride?: TRuntime;
  headers?: { host?: string };
};

export type RouteRequestContext<TBody, TRuntime> = {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  pathname: string;
  runtime: TRuntime;
  readJsonBody: () => Promise<TBody | null>;
  json: (_res: ServerResponse, data: unknown, status?: number) => void;
  error: (_res: ServerResponse, message: string, status?: number) => void;
};

type RouteInvokerOptions<TRuntime = unknown> =
  | {
      runtime: TRuntime;
      runtimeProvider?: undefined;
    }
  | {
      runtime?: undefined;
      runtimeProvider: () => TRuntime;
    };

export function createRouteInvoker<
  TBody = RouteBody,
  TRuntime = unknown,
  TPayload = unknown,
>(
  handler: (ctx: RouteRequestContext<TBody, TRuntime>) => Promise<boolean>,
  options: RouteInvokerOptions<TRuntime>,
): (
  args: RouteInvokeArgs<TBody, TRuntime>,
) => Promise<RouteInvocationResult<TPayload>> {
  return async (args) => {
    const capturedRuntime =
      options.runtimeProvider === undefined
        ? options.runtime
        : options.runtimeProvider();

    const status = 200;
    const payload = {} as TPayload;

    const response = {
      hasPayload: false,
      status,
      payload,
    };

    const { res, getStatus, getJson } = createMockHttpResponse<TPayload>();

    const req = {
      url: args.url ?? args.pathname,
      headers: { host: args.headers?.host ?? "localhost:2138" },
    } as IncomingMessage;

    const runtime =
      args.runtimeOverride === undefined
        ? capturedRuntime
        : args.runtimeOverride;

    const handled = await handler({
      req,
      res,
      method: args.method,
      pathname: args.pathname,
      runtime: runtime as TRuntime,
      readJsonBody: async () => {
        const body = args.body ?? null;
        return (body as TBody | null) ?? null;
      },
      json: (_response, data, status = 200) => {
        response.hasPayload = true;
        response.status = status;
        response.payload = data as TPayload;
      },
      error: (_response, message, status = 400) => {
        response.hasPayload = true;
        response.status = status;
        response.payload = { error: message } as TPayload;
      },
    });

    if (!response.hasPayload) {
      response.status = getStatus();
      response.payload = getJson();
      response.hasPayload = true;
    }

    return {
      handled,
      status: response.status,
      payload: response.payload,
    };
  };
}

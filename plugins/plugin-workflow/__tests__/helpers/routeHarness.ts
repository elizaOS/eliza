/** Shared in-memory HTTP transport harness for invoking workflow Route handlers. */
import type { RouteRequest, RouteResponse } from '@elizaos/core';

export function createRouteRequest(overrides?: Partial<RouteRequest>): RouteRequest {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    method: 'GET',
    ...overrides,
  };
}

export function createRouteResponse(): {
  response: RouteResponse;
  result: () => { status: number; body: unknown };
} {
  let status = 200;
  let body: unknown;
  const response: RouteResponse = {
    status(code: number) {
      status = code;
      return response;
    },
    json(data: unknown) {
      body = data;
      return response;
    },
    send(data: unknown) {
      body = data;
      return response;
    },
    end() {
      return response;
    },
  };
  return { response, result: () => ({ status, body }) };
}

export type AppControlHttpRequest = {
  body: unknown;
  method: string;
  pathname: string;
  response?: {
    body: unknown;
    status: number;
  };
  search: string;
  url: string;
};

export type AppControlHttpHandler = (
  request: AppControlHttpRequest,
) => Response | undefined | Promise<Response | undefined>;

type AppControlHttpLoopbackState = {
  handlers: AppControlHttpHandler[];
  originalFetch: typeof fetch;
  requests: AppControlHttpRequest[];
};

const LOOPBACK_STATE = Symbol.for("scenario-runner.app-control-http-loopback");

function parseUrl(input: string | URL | Request): URL | null {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    return new URL(input.url);
  } catch {
    return null;
  }
}

async function parseJsonText(text: string): Promise<unknown> {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function parseRequestBody(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<unknown> {
  const body = init?.body;
  if (typeof body === "string") return parseJsonText(body);
  if (body instanceof URLSearchParams) return body.toString();
  if (body !== undefined && body !== null) return body;
  if (input instanceof Request) {
    try {
      return parseJsonText(await input.clone().text());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  try {
    return parseJsonText(await response.clone().text());
  } catch {
    return undefined;
  }
}

function shouldHandle(url: URL | null): url is URL {
  return (
    url !== null &&
    url.hostname === "127.0.0.1" &&
    (url.pathname.startsWith("/api/views") ||
      url.pathname.startsWith("/api/apps") ||
      // VIEWS/delete now uninstalls via POST /api/plugins/uninstall.
      url.pathname.startsWith("/api/plugins"))
  );
}

function getState(): AppControlHttpLoopbackState {
  const globalWithLoopback = globalThis as typeof globalThis & {
    [LOOPBACK_STATE]?: AppControlHttpLoopbackState;
  };
  const existing = globalWithLoopback[LOOPBACK_STATE];
  if (existing) return existing;

  const state: AppControlHttpLoopbackState = {
    handlers: [],
    originalFetch: globalThis.fetch.bind(globalThis) as typeof fetch,
    requests: [],
  };

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = parseUrl(input);
    if (!shouldHandle(url)) {
      return state.originalFetch(input as Parameters<typeof fetch>[0], init);
    }

    const request: AppControlHttpRequest = {
      body: await parseRequestBody(input, init),
      method:
        init?.method ??
        (input instanceof Request && typeof input.method === "string"
          ? input.method
          : "GET"),
      pathname: url.pathname,
      search: url.search,
      url: url.toString(),
    };
    state.requests.push(request);

    for (const handler of state.handlers) {
      const response = await handler(request);
      if (!response) continue;
      request.response = {
        body: await parseResponseBody(response),
        status: response.status,
      };
      return response;
    }

    const response = await state.originalFetch(
      input as Parameters<typeof fetch>[0],
      init,
    );
    request.response = {
      body: await parseResponseBody(response),
      status: response.status,
    };
    return response;
  }) as typeof fetch;

  globalWithLoopback[LOOPBACK_STATE] = state;
  return state;
}

export function resetAppControlHttpLoopback(): void {
  const state = getState();
  state.handlers.length = 0;
  state.requests.length = 0;
}

export function registerAppControlHttpHandler(
  handler: AppControlHttpHandler,
): void {
  getState().handlers.push(handler);
}

export function readAppControlHttpRequests(
  predicate?: (request: AppControlHttpRequest) => boolean,
): AppControlHttpRequest[] {
  const requests = getState().requests;
  return predicate ? requests.filter(predicate) : [...requests];
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

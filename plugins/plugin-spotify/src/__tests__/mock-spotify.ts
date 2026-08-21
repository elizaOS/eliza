/**
 * Deterministic, protocol-faithful fetch harness for the Spotify test suites.
 * Routes are matched by method + URL prefix and answered with real Spotify
 * response shapes (paged envelopes, error envelopes with reason codes,
 * Retry-After headers, token grants), so the client and provider are tested
 * against the wire contract rather than a mock of themselves.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | undefined;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

interface Route {
  method: string;
  match: (url: string) => boolean;
  respond: Responder;
  times?: number;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

export function spotifyError(status: number, message: string, reason?: string): Response {
  return jsonResponse(status, {
    error: { status, message, ...(reason ? { reason } : {}) },
  });
}

export function pagedEnvelope<T>(args: {
  items: T[];
  total: number;
  offset: number;
  limit: number;
  base: string;
}) {
  const hasNext = args.offset + args.items.length < args.total;
  return {
    href: args.base,
    items: args.items,
    limit: args.limit,
    offset: args.offset,
    total: args.total,
    next: hasNext ? `${args.base}?offset=${args.offset + args.items.length}` : null,
    previous: null,
  };
}

export function rawTrack(id: string, name: string, artist = "Artist") {
  return {
    id,
    uri: `spotify:track:${id}`,
    name,
    artists: [{ id: `artist-${id}`, name: artist }],
    album: { name: `${name} Album` },
    duration_ms: 200_000,
    explicit: false,
  };
}

export function rawPlaylist(id: string, name: string, trackCount = 3) {
  return {
    id,
    uri: `spotify:playlist:${id}`,
    name,
    description: "",
    tracks: { total: trackCount },
    public: false,
    owner: { id: "user-1" },
  };
}

export function rawDevice(id: string, name: string, isActive = false) {
  return {
    id,
    name,
    type: "Computer",
    is_active: isActive,
    is_private_session: false,
    is_restricted: false,
    volume_percent: 60,
  };
}

export function tokenGrantBody(args: {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
}) {
  return {
    access_token: args.accessToken,
    token_type: "Bearer",
    expires_in: args.expiresIn ?? 3600,
    scope: args.scope ?? "user-library-read user-read-playback-state",
    ...(args.refreshToken ? { refresh_token: args.refreshToken } : {}),
  };
}

export class MockSpotify {
  readonly requests: RecordedRequest[] = [];
  private routes: Route[] = [];

  on(method: string, urlPrefix: string, respond: Responder, times?: number): this {
    this.routes.push({
      method: method.toUpperCase(),
      match: (url) => url.startsWith(urlPrefix),
      respond,
      ...(times !== undefined ? { times } : {}),
    });
    return this;
  }

  get fetch(): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(init?.headers ?? {})) {
        headers[key.toLowerCase()] = String(value);
      }
      const request: RecordedRequest = {
        method,
        url,
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      this.requests.push(request);
      const index = this.routes.findIndex((route) => route.method === method && route.match(url));
      if (index === -1) {
        throw new Error(`MockSpotify: no route for ${method} ${url}`);
      }
      const route = this.routes[index] as Route;
      if (route.times !== undefined) {
        route.times -= 1;
        if (route.times <= 0) this.routes.splice(index, 1);
      }
      return route.respond(request);
    }) as typeof fetch;
  }
}

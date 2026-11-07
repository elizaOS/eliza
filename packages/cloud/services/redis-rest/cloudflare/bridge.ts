import { timingSafeEqual } from "node:crypto";

export interface BridgeSettings {
  SRH_TOKEN: string;
  SRH_CONNECTION_STRING: string;
}

export class BridgeConfigurationError extends Error {
  constructor() {
    super("Redis bridge requires a token and an external Redis connection URL");
    this.name = "BridgeConfigurationError";
  }
}

export function containerSettings(env: BridgeSettings): Record<string, string> {
  let url: URL;
  try {
    url = new URL(env.SRH_CONNECTION_STRING);
  } catch {
    throw new BridgeConfigurationError();
  }
  if (
    !env.SRH_TOKEN?.trim() ||
    !["redis:", "rediss:"].includes(url.protocol) ||
    !url.hostname ||
    url.hostname.endsWith(".railway.internal")
  ) {
    throw new BridgeConfigurationError();
  }
  return {
    SRH_MODE: "env",
    SRH_TOKEN: env.SRH_TOKEN,
    SRH_CONNECTION_STRING: env.SRH_CONNECTION_STRING,
    PORT: "80",
    SRH_PORT: "80",
  };
}

/** Authenticate before waking compute; forward the original protocol unchanged. */
export async function forwardBridgeRequest(
  request: Request,
  token: string | undefined,
  forward: (request: Request) => Promise<Response>,
): Promise<Response> {
  if (!token?.trim()) {
    return new Response("Redis bridge unavailable", { status: 503 });
  }
  const expected = new TextEncoder().encode(`Bearer ${token}`);
  const actual = new TextEncoder().encode(
    request.headers.get("Authorization") ?? "",
  );
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return forward(request);
}

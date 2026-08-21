/** Exercises malformed request input with deterministic route collaborators. */
import http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import { handleElizaCompatRoute } from "./server";

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

const ENV_KEYS = [
  "ELIZA_API_TOKEN",
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_REQUIRE_LOCAL_AUTH",
] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function trustedLoopbackReq(
  method: string,
  pathname: string,
): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "127.0.0.1:2138" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

function captureRes() {
  let body = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  const socket = new Socket();
  res.assignSocket(socket);
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") body += chunk;
    else if (chunk) body += chunk.toString("utf8");
    socket.destroy();
    return res;
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    json: () => (body ? JSON.parse(body) : null),
  };
}

describe("GET /api/plugins/:id/ui-spec path encoding", () => {
  it("returns 400 for a malformed percent-encoded plugin id instead of throwing", async () => {
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      trustedLoopbackReq("GET", "/api/plugins/%ZZ/ui-spec"),
      cap.res,
      STATE,
    );
    expect(handled).toBe(true);
    expect(cap.status()).toBe(400);
    expect(cap.json()).toEqual({
      error: "Invalid plugin id: malformed URL encoding",
    });
  });

  it("still looks up a canonically encoded plugin id", async () => {
    const cap = captureRes();
    const handled = await handleElizaCompatRoute(
      trustedLoopbackReq("GET", "/api/plugins/%74elegram/ui-spec"),
      cap.res,
      STATE,
    );
    expect(handled).toBe(true);
    expect(cap.status()).toBe(200);
    expect(cap.json()).toMatchObject({ spec: expect.any(Object) });
  });
});

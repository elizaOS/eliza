/**
 * #12087 Item 4: the secrets handlers must reject non-OWNER callers on their own,
 * not merely rely on the `/api/secrets/*` prefix gate in server.ts. These tests
 * call each handler DIRECTLY (bypassing the dispatch prefix) with a remote,
 * unauthenticated caller and assert a 401 before any secrets logic runs, plus a
 * false return (no auth side effects) for paths outside the secrets prefix.
 */
import * as http from "node:http";
import { Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompatStateLike } from "./auth.ts";
import { handleSecretsInventoryRoute } from "./secrets-inventory-routes";
import { handleSecretsManagerRoute } from "./secrets-manager-routes";

interface FakeRes {
  res: http.ServerResponse;
  status(): number;
}

function fakeRes(): FakeRes {
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = (() => res) as typeof res.end;
  return {
    res,
    status() {
      return res.statusCode;
    },
  };
}

function remoteReq(method: string, pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = method;
  req.url = pathname;
  req.headers = { host: "agent.example.test" };
  Object.defineProperty(req.socket, "remoteAddress", {
    // A distinct public IP per call keeps auth rate-limiting from bleeding
    // across cases.
    value: `203.0.113.${Math.floor(remoteReq.n++ % 200) + 1}`,
    configurable: true,
  });
  return req;
}
remoteReq.n = 1;

// No adapter/db and no configured token → the only OWNER principal is a trusted
// same-machine caller, which a remote request is not.
const noAuthState: CompatStateLike = { current: null };

const priorToken = process.env.ELIZA_API_TOKEN;

beforeEach(() => {
  delete process.env.ELIZA_API_TOKEN;
});
afterEach(() => {
  if (priorToken === undefined) delete process.env.ELIZA_API_TOKEN;
  else process.env.ELIZA_API_TOKEN = priorToken;
});

describe("secrets handlers self-gate at OWNER (#12087 Item 4)", () => {
  it("handleSecretsManagerRoute rejects a remote non-OWNER caller with 401", async () => {
    const res = fakeRes();
    const handled = await handleSecretsManagerRoute(
      remoteReq("GET", "/api/secrets/manager/backends"),
      res.res,
      "/api/secrets/manager/backends",
      "GET",
      noAuthState,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
  });

  it("handleSecretsInventoryRoute rejects a remote non-OWNER caller with 401", async () => {
    const res = fakeRes();
    const handled = await handleSecretsInventoryRoute(
      remoteReq("GET", "/api/secrets/routing"),
      res.res,
      "/api/secrets/routing",
      "GET",
      noAuthState,
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(401);
  });

  it("both handlers ignore paths outside their prefix (returns false, no auth side effects)", async () => {
    const managerRes = fakeRes();
    expect(
      await handleSecretsManagerRoute(
        remoteReq("GET", "/api/other"),
        managerRes.res,
        "/api/other",
        "GET",
        noAuthState,
      ),
    ).toBe(false);

    const inventoryRes = fakeRes();
    expect(
      await handleSecretsInventoryRoute(
        remoteReq("GET", "/api/other"),
        inventoryRes.res,
        "/api/other",
        "GET",
        noAuthState,
      ),
    ).toBe(false);
  });
});

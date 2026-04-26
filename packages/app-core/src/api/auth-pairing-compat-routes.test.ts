import crypto from "node:crypto";
import type http from "node:http";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthPairingStateForTests,
  handleAuthPairingCompatRoutes,
} from "./auth-pairing-compat-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader() {},
    end(chunk?: string | Buffer) {
      if (typeof chunk === "string") bodyText += chunk;
      else if (chunk) bodyText += chunk.toString("utf8");
    },
  } as unknown as http.ServerResponse;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return (res as unknown as { statusCode: number }).statusCode;
    },
  };
}

function fakeReq(opts: {
  method: string;
  pathname: string;
  body?: unknown;
  ip?: string;
  host?: string;
}): http.IncomingMessage {
  const bodyStr = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const stream = Readable.from([bodyStr]) as unknown as http.IncomingMessage;
  Object.assign(stream, {
    method: opts.method,
    url: opts.pathname,
    headers: { host: opts.host ?? "example.com" },
    socket: {
      remoteAddress: opts.ip ?? "203.0.113.10",
    },
  });
  return stream;
}

describe("auth pairing compat routes", () => {
  const originalToken = process.env.ELIZA_API_TOKEN;
  const originalPairingDisabled = process.env.ELIZA_PAIRING_DISABLED;
  const originalCloudProvisioned = process.env.ELIZA_CLOUD_PROVISIONED;

  beforeEach(() => {
    _resetAuthPairingStateForTests();
    process.env.ELIZA_API_TOKEN = "pairing-test-token";
    delete process.env.ELIZA_PAIRING_DISABLED;
    delete process.env.ELIZA_CLOUD_PROVISIONED;
  });

  afterEach(() => {
    _resetAuthPairingStateForTests();
    vi.restoreAllMocks();
    if (originalToken === undefined) delete process.env.ELIZA_API_TOKEN;
    else process.env.ELIZA_API_TOKEN = originalToken;
    if (originalPairingDisabled === undefined) {
      delete process.env.ELIZA_PAIRING_DISABLED;
    } else {
      process.env.ELIZA_PAIRING_DISABLED = originalPairingDisabled;
    }
    if (originalCloudProvisioned === undefined) {
      delete process.env.ELIZA_CLOUD_PROVISIONED;
    } else {
      process.env.ELIZA_CLOUD_PROVISIONED = originalCloudProvisioned;
    }
  });

  it("opens pairing for remote static-token clients and redeems the generated code", async () => {
    vi.spyOn(crypto, "randomInt").mockReturnValue(0);

    const statusRes = fakeRes();
    expect(
      await handleAuthPairingCompatRoutes(
        fakeReq({ method: "GET", pathname: "/api/auth/status" }),
        statusRes.res,
        STATE,
      ),
    ).toBe(true);
    expect(statusRes.status()).toBe(200);
    expect(statusRes.body()).toMatchObject({
      required: true,
      loginRequired: false,
      bootstrapRequired: false,
      localAccess: false,
      pairingEnabled: true,
    });

    const pairRes = fakeRes();
    expect(
      await handleAuthPairingCompatRoutes(
        fakeReq({
          method: "POST",
          pathname: "/api/auth/pair",
          body: { code: "aaaa aaaa aaaa" },
        }),
        pairRes.res,
        STATE,
      ),
    ).toBe(true);
    expect(pairRes.status()).toBe(200);
    expect(pairRes.body()).toEqual({ token: "pairing-test-token" });
  });

  it("disables pairing when ELIZA_PAIRING_DISABLED=1", async () => {
    process.env.ELIZA_PAIRING_DISABLED = "1";

    const statusRes = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({ method: "GET", pathname: "/api/auth/status" }),
      statusRes.res,
      STATE,
    );
    expect(statusRes.body()).toMatchObject({
      required: true,
      pairingEnabled: false,
    });

    const pairRes = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/pair",
        body: { code: "AAAA-AAAA-AAAA" },
      }),
      pairRes.res,
      STATE,
    );
    expect(pairRes.status()).toBe(403);
    expect(pairRes.body()).toMatchObject({ error: "Pairing disabled" });
  });

  it("does not require pairing for same-machine local dashboard access", async () => {
    const res = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/status",
        ip: "127.0.0.1",
        host: "localhost:2138",
      }),
      res.res,
      STATE,
    );

    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({
      required: false,
      localAccess: true,
      pairingEnabled: true,
    });
  });
});

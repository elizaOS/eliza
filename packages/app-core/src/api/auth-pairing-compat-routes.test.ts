import crypto from "node:crypto";
import type http from "node:http";
import { Readable } from "node:stream";
import { logger } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetAuthPairingStateForTests,
  ensureAuthPairingCodeForRemoteAccess,
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
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const bodyStr = opts.body === undefined ? "" : JSON.stringify(opts.body);
  const stream = Readable.from([bodyStr]) as unknown as http.IncomingMessage;
  Object.assign(stream, {
    method: opts.method,
    url: opts.pathname,
    headers: { host: opts.host ?? "example.com", ...opts.headers },
    socket: {
      remoteAddress: opts.ip ?? "203.0.113.10",
    },
  });
  return stream;
}

function mockGeneratedPairingCodes(...alphabetIndexes: number[]): void {
  let callCount = 0;
  vi.spyOn(crypto, "randomInt").mockImplementation(() => {
    const codeIndex = Math.floor(callCount / 12);
    callCount += 1;
    return (
      alphabetIndexes[Math.min(codeIndex, alphabetIndexes.length - 1)] ?? 0
    );
  });
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
    vi.useRealTimers();
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

  it("simulates two remote device contexts through wrong code, consume, bearer access, and reuse rejection", async () => {
    mockGeneratedPairingCodes(0, 1);

    const ownerBrowser = {
      ip: "198.51.100.10",
      host: "owner.example.test",
    };
    const phoneBrowser = {
      ip: "203.0.113.55",
      host: "phone.example.test",
    };

    const ownerStatus = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/status",
        ...ownerBrowser,
      }),
      ownerStatus.res,
      STATE,
    );
    expect(ownerStatus.status()).toBe(200);
    expect(ownerStatus.body()).toMatchObject({
      required: true,
      authenticated: false,
      localAccess: false,
      pairingEnabled: true,
    });
    expect(
      (ownerStatus.body() as { expiresAt: number | null }).expiresAt,
    ).toEqual(expect.any(Number));

    const wrongCode = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/pair",
        body: { code: "BBBB-BBBB-BBBB" },
        ...phoneBrowser,
      }),
      wrongCode.res,
      STATE,
    );
    expect(wrongCode.status()).toBe(403);
    expect(wrongCode.body()).toMatchObject({ error: "Invalid pairing code" });

    const successfulPair = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/pair",
        body: { code: "aaaa aaaa aaaa" },
        ...phoneBrowser,
      }),
      successfulPair.res,
      STATE,
    );
    expect(successfulPair.status()).toBe(200);
    expect(successfulPair.body()).toEqual({ token: "pairing-test-token" });

    const pairedPhoneStatus = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "GET",
        pathname: "/api/auth/status",
        headers: { authorization: "Bearer pairing-test-token" },
        ...phoneBrowser,
      }),
      pairedPhoneStatus.res,
      STATE,
    );
    expect(pairedPhoneStatus.status()).toBe(200);
    expect(pairedPhoneStatus.body()).toMatchObject({
      required: false,
      authenticated: true,
      localAccess: false,
      pairingEnabled: true,
    });

    const reusedCode = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/pair",
        body: { code: "AAAA-AAAA-AAAA" },
        ip: "203.0.113.99",
        host: "second-phone.example.test",
      }),
      reusedCode.res,
      STATE,
    );
    expect(reusedCode.status()).toBe(403);
    expect(reusedCode.body()).toMatchObject({ error: "Invalid pairing code" });
  });

  it("rejects an expired pending code and allows the replacement code to be consumed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    mockGeneratedPairingCodes(0, 1);

    const statusRes = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({ method: "GET", pathname: "/api/auth/status" }),
      statusRes.res,
      STATE,
    );
    expect(statusRes.status()).toBe(200);
    expect(statusRes.body()).toMatchObject({
      required: true,
      pairingEnabled: true,
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    const expiredCode = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/pair",
        body: { code: "AAAA-AAAA-AAAA" },
      }),
      expiredCode.res,
      STATE,
    );
    expect(expiredCode.status()).toBe(403);
    expect(expiredCode.body()).toMatchObject({ error: "Invalid pairing code" });

    expect(ensureAuthPairingCodeForRemoteAccess()).toMatchObject({
      code: "BBBB-BBBB-BBBB",
      expiresAt: Date.now() + 10 * 60 * 1000,
    });

    const replacementCode = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/pair",
        body: { code: "BBBB-BBBB-BBBB" },
      }),
      replacementCode.res,
      STATE,
    );
    expect(replacementCode.status()).toBe(200);
    expect(replacementCode.body()).toEqual({ token: "pairing-test-token" });
  });

  it("can pre-generate and log the pairing code before a remote client probes auth status", async () => {
    vi.spyOn(crypto, "randomInt").mockReturnValue(0);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    expect(ensureAuthPairingCodeForRemoteAccess()).toMatchObject({
      code: "AAAA-AAAA-AAAA",
    });
    expect(warn).toHaveBeenCalledWith(
      "[api] Pairing code for remote devices: AAAA-AAAA-AAAA (valid for 10 minutes)",
    );

    const pairRes = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({
        method: "POST",
        pathname: "/api/auth/pair",
        body: { code: "aaaa aaaa aaaa" },
      }),
      pairRes.res,
      STATE,
    );

    expect(pairRes.status()).toBe(200);
    expect(pairRes.body()).toEqual({ token: "pairing-test-token" });
  });

  it("routes cloud-provisioned containers to bootstrap instead of pairing even with an API token", async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    vi.spyOn(crypto, "randomInt").mockReturnValue(0);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    expect(ensureAuthPairingCodeForRemoteAccess()).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    const statusRes = fakeRes();
    await handleAuthPairingCompatRoutes(
      fakeReq({ method: "GET", pathname: "/api/auth/status" }),
      statusRes.res,
      STATE,
    );

    expect(statusRes.status()).toBe(200);
    expect(statusRes.body()).toMatchObject({
      required: true,
      authenticated: false,
      bootstrapRequired: true,
      loginRequired: false,
      pairingEnabled: false,
      expiresAt: null,
    });
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

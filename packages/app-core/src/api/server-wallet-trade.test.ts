/**
 * Colocated coverage for the app-core wallet-export hardening layer. Drives the
 * real module: header alias mirroring, upstream token/confirm rejection,
 * missing-IP rejection, nonce issue/cap/TTL sweep/IP-binding/confirmation delay,
 * nonce replay, missing nonce, and per-IP rate limiting. IncomingMessage is a
 * socket/header stub; the guard and `@elizaos/agent` upstream are not mocked.
 */
import type http from "node:http";
import type { WalletExportRequestBody } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeCompatRejection,
  resolveWalletExportRejection,
  runWithCompatAuthContext,
} from "./server-wallet-trade";

const EXPORT_TOKEN = "app-core-wallet-export-secret";
const EXPORT_DELAY_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const NONCE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_NONCES_PER_IP = 3;

const TOUCHED_ENV_KEYS = [
  "ELIZA_WALLET_EXPORT_TOKEN",
  "MILADY_WALLET_EXPORT_TOKEN",
] as const;

type HardenedExportBody = WalletExportRequestBody & {
  exportNonce?: string;
  requestNonce?: boolean;
};

let ipSeq = 0;

function nextIp(): string {
  ipSeq += 1;
  return `198.51.100.${(ipSeq % 254) + 1}`;
}

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    TOUCHED_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function request(
  remoteAddress: string | null | undefined = nextIp(),
  headers: http.IncomingHttpHeaders = {},
): http.IncomingMessage {
  return {
    headers: { "user-agent": "server-wallet-trade-test", ...headers },
    socket: { remoteAddress },
  } as unknown as http.IncomingMessage;
}

function authorizedBody(
  overrides: HardenedExportBody = {},
): HardenedExportBody {
  return {
    confirm: true,
    exportToken: EXPORT_TOKEN,
    ...overrides,
  };
}

function parseIssuedNonce(reason: string): {
  countdown: boolean;
  delaySeconds: number;
  message: string;
  nonce: string;
} {
  const parsed = JSON.parse(reason) as {
    countdown?: unknown;
    delaySeconds?: unknown;
    message?: unknown;
    nonce?: unknown;
  };
  if (
    parsed.countdown !== true ||
    typeof parsed.delaySeconds !== "number" ||
    typeof parsed.message !== "string" ||
    typeof parsed.nonce !== "string"
  ) {
    throw new Error(`unexpected nonce payload: ${reason}`);
  }
  return {
    countdown: parsed.countdown,
    delaySeconds: parsed.delaySeconds,
    message: parsed.message,
    nonce: parsed.nonce,
  };
}

function enableExportToken(): void {
  process.env.ELIZA_WALLET_EXPORT_TOKEN = EXPORT_TOKEN;
}

describe("normalizeCompatRejection", () => {
  it("returns null unchanged", () => {
    expect(normalizeCompatRejection(null)).toBeNull();
  });

  it("returns the same rejection object and leaves the reason text intact", () => {
    const rejection = { status: 403, reason: "Export requires confirmation." };
    expect(normalizeCompatRejection(rejection)).toBe(rejection);
    expect(rejection).toEqual({
      status: 403,
      reason: "Export requires confirmation.",
    });
  });
});

describe("runWithCompatAuthContext", () => {
  it("copies a present x-elizaos-* header onto the empty x-eliza-* alias", () => {
    const req = request("127.0.0.1", {
      "x-elizaos-export-token": "from-app",
    });
    const result = runWithCompatAuthContext(req, () => {
      expect(req.headers["x-eliza-export-token"]).toBe("from-app");
      return "mirrored";
    });
    expect(result).toBe("mirrored");
    expect(req.headers["x-elizaos-export-token"]).toBe("from-app");
  });

  it("copies a present x-eliza-* header onto the empty x-elizaos-* alias", () => {
    const req = request("127.0.0.1", {
      "x-eliza-token": "from-eliza",
      "x-eliza-client-id": "client-a",
      "x-eliza-terminal-token": "term",
      "x-eliza-ui-language": "en",
      "x-eliza-agent-action": "export",
    });
    runWithCompatAuthContext(req, () => undefined);
    expect(req.headers["x-elizaos-token"]).toBe("from-eliza");
    expect(req.headers["x-elizaos-client-id"]).toBe("client-a");
    expect(req.headers["x-elizaos-terminal-token"]).toBe("term");
    expect(req.headers["x-elizaos-ui-language"]).toBe("en");
    expect(req.headers["x-elizaos-agent-action"]).toBe("export");
  });

  it("does not overwrite an alias when both header names are already set", () => {
    const req = request("127.0.0.1", {
      "x-elizaos-export-token": "app-value",
      "x-eliza-export-token": "eliza-value",
    });
    runWithCompatAuthContext(req, () => undefined);
    expect(req.headers["x-elizaos-export-token"]).toBe("app-value");
    expect(req.headers["x-eliza-export-token"]).toBe("eliza-value");
  });
});

describe("resolveWalletExportRejection", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    for (const key of TOUCHED_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
    vi.useRealTimers();
  });

  it("rejects before hardening when confirm is missing", () => {
    enableExportToken();
    const rejection = resolveWalletExportRejection(
      request(),
      authorizedBody({ confirm: undefined, requestNonce: true }),
    );
    expect(rejection).toEqual({
      status: 403,
      reason:
        'Export requires explicit confirmation. Send { "confirm": true } in the request body.',
    });
  });

  it("reports export disabled when no wallet export token is configured", () => {
    const rejection = resolveWalletExportRejection(request(), {
      confirm: true,
    });
    expect(rejection).toEqual({
      status: 403,
      reason:
        "Wallet export is disabled. Set ELIZA_WALLET_EXPORT_TOKEN to enable secure exports.",
    });
  });

  it("rejects a missing export token after the token is configured", () => {
    enableExportToken();
    expect(resolveWalletExportRejection(request(), { confirm: true })).toEqual({
      status: 401,
      reason:
        "Missing export token. Provide X-Eliza-Export-Token header or exportToken in request body.",
    });
  });

  it("rejects an invalid export token before issuing a nonce", () => {
    enableExportToken();
    expect(
      resolveWalletExportRejection(
        request(),
        authorizedBody({ exportToken: "wrong-token", requestNonce: true }),
      ),
    ).toEqual({ status: 401, reason: "Invalid export token." });
  });

  it("accepts the export token from the x-elizaos-export-token header via alias mirroring", () => {
    enableExportToken();
    const req = request(nextIp(), {
      "x-elizaos-export-token": EXPORT_TOKEN,
    });
    const rejection = resolveWalletExportRejection(req, { confirm: true });
    expect(rejection?.status).toBe(403);
    expect(rejection?.reason).toContain("requestNonce");
    expect(req.headers["x-eliza-export-token"]).toBe(EXPORT_TOKEN);
  });

  it("rejects when the socket has no client IP, even with a valid token", () => {
    enableExportToken();
    expect(
      resolveWalletExportRejection(
        request(null),
        authorizedBody({ requestNonce: true }),
      ),
    ).toEqual({
      status: 400,
      reason: "Unable to determine client IP; request rejected.",
    });
    expect(resolveWalletExportRejection(request(""), authorizedBody())).toEqual(
      {
        status: 400,
        reason: "Unable to determine client IP; request rejected.",
      },
    );
  });

  it("requires a confirmation nonce before an otherwise authorized export", () => {
    enableExportToken();
    expect(resolveWalletExportRejection(request(), authorizedBody())).toEqual({
      status: 403,
      reason:
        'Export requires a confirmation delay. First send { "confirm": true, "exportToken": "...", "requestNonce": true } to start the countdown.',
    });
  });

  it("treats an empty exportNonce as missing", () => {
    enableExportToken();
    expect(
      resolveWalletExportRejection(
        request(),
        authorizedBody({ exportNonce: "" }),
      ),
    ).toMatchObject({
      status: 403,
      reason: expect.stringContaining("requestNonce"),
    });
  });

  it("issues a wxn_ nonce, enforces the 10s delay, allows once, then rejects replay", () => {
    enableExportToken();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    const req = request();

    const issued = resolveWalletExportRejection(
      req,
      authorizedBody({ requestNonce: true }),
    );
    expect(issued?.status).toBe(403);
    const payload = parseIssuedNonce(issued?.reason ?? "");
    expect(payload.nonce).toMatch(/^wxn_[a-f0-9]{32}$/);
    expect(payload.delaySeconds).toBe(EXPORT_DELAY_MS / 1000);
    expect(payload.message).toContain(payload.nonce);

    expect(
      resolveWalletExportRejection(
        req,
        authorizedBody({ exportNonce: payload.nonce }),
      ),
    ).toEqual({
      status: 403,
      reason: "Export confirmation delay not met. Wait 10 more seconds.",
    });

    vi.advanceTimersByTime(EXPORT_DELAY_MS - 1);
    expect(
      resolveWalletExportRejection(
        req,
        authorizedBody({ exportNonce: payload.nonce }),
      )?.reason,
    ).toBe("Export confirmation delay not met. Wait 1 more seconds.");

    vi.advanceTimersByTime(1);
    expect(
      resolveWalletExportRejection(
        req,
        authorizedBody({ exportNonce: payload.nonce }),
      ),
    ).toBeNull();

    expect(
      resolveWalletExportRejection(
        req,
        authorizedBody({ exportNonce: payload.nonce }),
      ),
    ).toEqual({
      status: 403,
      reason: "Invalid or expired export nonce.",
    });
  });

  it("rejects a nonce that was never issued", () => {
    enableExportToken();
    expect(
      resolveWalletExportRejection(
        request(),
        authorizedBody({ exportNonce: "wxn_deadbeefdeadbeefdeadbeefdeadbeef" }),
      ),
    ).toEqual({
      status: 403,
      reason: "Invalid or expired export nonce.",
    });
  });

  it("binds a nonce to the issuing socket IP", () => {
    enableExportToken();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:10:00.000Z"));
    const issuerIp = nextIp();
    const issued = resolveWalletExportRejection(
      request(issuerIp),
      authorizedBody({ requestNonce: true }),
    );
    const nonce = parseIssuedNonce(issued?.reason ?? "").nonce;
    vi.advanceTimersByTime(EXPORT_DELAY_MS);

    expect(
      resolveWalletExportRejection(
        request(nextIp()),
        authorizedBody({ exportNonce: nonce }),
      ),
    ).toEqual({
      status: 403,
      reason: "Export nonce was issued to a different client.",
    });
    expect(
      resolveWalletExportRejection(
        request(issuerIp),
        authorizedBody({ exportNonce: nonce }),
      ),
    ).toBeNull();
  });

  it("caps pending nonces per IP at three and isolates the cap by address", () => {
    enableExportToken();
    const busyIp = nextIp();
    const otherIp = nextIp();
    const busyReq = request(busyIp);

    for (let i = 0; i < MAX_PENDING_NONCES_PER_IP; i += 1) {
      expect(
        resolveWalletExportRejection(
          busyReq,
          authorizedBody({ requestNonce: true }),
        )?.status,
      ).toBe(403);
    }

    expect(
      resolveWalletExportRejection(
        busyReq,
        authorizedBody({ requestNonce: true }),
      ),
    ).toEqual({
      status: 429,
      reason:
        "Too many pending export requests. Complete or wait for existing nonces to expire.",
    });

    const other = resolveWalletExportRejection(
      request(otherIp),
      authorizedBody({ requestNonce: true }),
    );
    expect(other?.status).toBe(403);
    expect(parseIssuedNonce(other?.reason ?? "").nonce).toMatch(
      /^wxn_[a-f0-9]{32}$/,
    );
  });

  it("sweeps TTL-expired pending nonces on the next issue for that IP", () => {
    enableExportToken();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:20:00.000Z"));
    const ip = nextIp();
    const req = request(ip);

    const first = parseIssuedNonce(
      resolveWalletExportRejection(req, authorizedBody({ requestNonce: true }))
        ?.reason ?? "",
    ).nonce;

    vi.advanceTimersByTime(NONCE_TTL_MS + 1);
    const secondIssued = resolveWalletExportRejection(
      req,
      authorizedBody({ requestNonce: true }),
    );
    const second = parseIssuedNonce(secondIssued?.reason ?? "").nonce;
    expect(second).not.toBe(first);

    expect(
      resolveWalletExportRejection(req, authorizedBody({ exportNonce: first })),
    ).toEqual({
      status: 403,
      reason: "Invalid or expired export nonce.",
    });

    vi.advanceTimersByTime(EXPORT_DELAY_MS);
    expect(
      resolveWalletExportRejection(
        req,
        authorizedBody({ exportNonce: second }),
      ),
    ).toBeNull();
  });

  it("does not expire a nonce at validation time until a later issue sweeps TTL", () => {
    enableExportToken();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:30:00.000Z"));
    const req = request();
    const nonce = parseIssuedNonce(
      resolveWalletExportRejection(req, authorizedBody({ requestNonce: true }))
        ?.reason ?? "",
    ).nonce;

    vi.advanceTimersByTime(NONCE_TTL_MS + EXPORT_DELAY_MS);
    expect(
      resolveWalletExportRejection(req, authorizedBody({ exportNonce: nonce })),
    ).toBeNull();
  });

  it("rate limits a second successful export on the same IP inside the 10-minute window", () => {
    enableExportToken();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T01:00:00.000Z"));
    const ip = nextIp();
    const otherIp = nextIp();
    const req = request(ip);

    const firstNonce = parseIssuedNonce(
      resolveWalletExportRejection(req, authorizedBody({ requestNonce: true }))
        ?.reason ?? "",
    ).nonce;
    vi.advanceTimersByTime(EXPORT_DELAY_MS);
    expect(
      resolveWalletExportRejection(
        req,
        authorizedBody({ exportNonce: firstNonce }),
      ),
    ).toBeNull();

    const secondNonce = parseIssuedNonce(
      resolveWalletExportRejection(req, authorizedBody({ requestNonce: true }))
        ?.reason ?? "",
    ).nonce;
    vi.advanceTimersByTime(EXPORT_DELAY_MS);
    const limited = resolveWalletExportRejection(
      req,
      authorizedBody({ exportNonce: secondNonce }),
    );
    expect(limited?.status).toBe(429);
    expect(limited?.reason).toMatch(
      /Rate limit exceeded\. One export per 10 minutes\. Retry after \d+ seconds\./,
    );

    const otherNonce = parseIssuedNonce(
      resolveWalletExportRejection(
        request(otherIp),
        authorizedBody({ requestNonce: true }),
      )?.reason ?? "",
    ).nonce;
    vi.advanceTimersByTime(EXPORT_DELAY_MS);
    expect(
      resolveWalletExportRejection(
        request(otherIp),
        authorizedBody({ exportNonce: otherNonce }),
      ),
    ).toBeNull();

    vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS - EXPORT_DELAY_MS);
    const thirdNonce = parseIssuedNonce(
      resolveWalletExportRejection(req, authorizedBody({ requestNonce: true }))
        ?.reason ?? "",
    ).nonce;
    vi.advanceTimersByTime(EXPORT_DELAY_MS);
    expect(
      resolveWalletExportRejection(
        req,
        authorizedBody({ exportNonce: thirdNonce }),
      ),
    ).toBeNull();
  });
});

/**
 * Unit tests for the hardened wallet-export guard: nonce-based replay
 * protection, audit-log recording, and rate-limiting behavior, driven with
 * fake timers and a synthetic `IncomingMessage`. No real HTTP server or
 * wallet key material is involved.
 */
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetForTesting,
  createHardenedExportGuard,
  getWalletExportAuditLog,
} from "./wallet-export-guard";

function request(
  remoteAddress: string | null = "127.0.0.1",
  userAgent = "wallet-test",
): http.IncomingMessage {
  return {
    headers: { "user-agent": userAgent },
    socket: { remoteAddress },
  } as unknown as http.IncomingMessage;
}

function parseNonce(reason: string): string {
  const parsed = JSON.parse(reason) as { nonce?: unknown };
  if (typeof parsed.nonce !== "string") {
    throw new Error(`missing nonce in ${reason}`);
  }
  return parsed.nonce;
}

describe("wallet export guard", () => {
  const upstream = vi.fn(() => null);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    upstream.mockReset();
    upstream.mockReturnValue(null);
    _resetForTesting();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _resetForTesting();
  });

  it("issues a nonce, enforces the confirmation delay, then allows exactly one export", () => {
    const guard = createHardenedExportGuard(upstream);
    const req = request();
    const nonceResponse = guard(req, {
      confirm: true,
      exportToken: "valid",
      requestNonce: true,
    });

    expect(nonceResponse?.status).toBe(403);
    const nonce = parseNonce(nonceResponse?.reason ?? "");
    expect(nonce).toMatch(/^wxn_[a-f0-9]{32}$/);

    const tooEarly = guard(req, {
      confirm: true,
      exportToken: "valid",
      exportNonce: nonce,
    });
    expect(tooEarly).toMatchObject({
      status: 403,
      reason: expect.stringContaining("Wait 10 more seconds"),
    });

    vi.advanceTimersByTime(10_000);
    expect(
      guard(req, {
        confirm: true,
        exportToken: "valid",
        exportNonce: nonce,
      }),
    ).toBeNull();

    const replay = guard(req, {
      confirm: true,
      exportToken: "valid",
      exportNonce: nonce,
    });
    expect(replay).toMatchObject({
      status: 403,
      reason: "Invalid or expired export nonce.",
    });
    expect(getWalletExportAuditLog().at(-2)?.outcome).toBe("allowed");
  });

  it("binds nonces to the socket IP and rejects requests without an IP", () => {
    const guard = createHardenedExportGuard(upstream);
    const nonceResponse = guard(request("127.0.0.1"), {
      confirm: true,
      exportToken: "valid",
      requestNonce: true,
    });
    const nonce = parseNonce(nonceResponse?.reason ?? "");
    vi.advanceTimersByTime(10_000);

    expect(
      guard(request("127.0.0.2"), {
        confirm: true,
        exportToken: "valid",
        exportNonce: nonce,
      }),
    ).toMatchObject({
      status: 403,
      reason: "Export nonce was issued to a different client.",
    });
    expect(
      guard(request(null), {
        confirm: true,
        exportToken: "valid",
        requestNonce: true,
      }),
    ).toMatchObject({
      status: 400,
      reason: "Unable to determine client IP; request rejected.",
    });
  });

  it("caps pending nonces per IP and trims the audit log", () => {
    const guard = createHardenedExportGuard(upstream);
    const req = request("10.0.0.1");

    for (let i = 0; i < 3; i += 1) {
      expect(
        guard(req, {
          confirm: true,
          exportToken: "valid",
          requestNonce: true,
        })?.status,
      ).toBe(403);
    }
    expect(
      guard(req, {
        confirm: true,
        exportToken: "valid",
        requestNonce: true,
      }),
    ).toMatchObject({
      status: 429,
      reason: expect.stringContaining("Too many pending export requests"),
    });

    for (let i = 0; i < 120; i += 1) {
      guard(request(`10.0.1.${i}`), {
        confirm: true,
        exportToken: "valid",
        requestNonce: true,
      });
    }
    expect(getWalletExportAuditLog()).toHaveLength(100);
  });

  it("rate limits successful exports per IP after nonce validation", () => {
    const guard = createHardenedExportGuard(upstream);
    const req = request("127.0.0.9");
    const firstNonce = parseNonce(
      guard(req, {
        confirm: true,
        exportToken: "valid",
        requestNonce: true,
      })?.reason ?? "",
    );
    vi.advanceTimersByTime(10_000);
    expect(
      guard(req, {
        confirm: true,
        exportToken: "valid",
        exportNonce: firstNonce,
      }),
    ).toBeNull();

    const secondNonce = parseNonce(
      guard(req, {
        confirm: true,
        exportToken: "valid",
        requestNonce: true,
      })?.reason ?? "",
    );
    vi.advanceTimersByTime(10_000);
    expect(
      guard(req, {
        confirm: true,
        exportToken: "valid",
        exportNonce: secondNonce,
      }),
    ).toMatchObject({
      status: 429,
      reason: expect.stringContaining("Rate limit exceeded"),
    });

    vi.advanceTimersByTime(10 * 60 * 1000);
    const thirdNonce = parseNonce(
      guard(req, {
        confirm: true,
        exportToken: "valid",
        requestNonce: true,
      })?.reason ?? "",
    );
    vi.advanceTimersByTime(10_000);
    expect(
      guard(req, {
        confirm: true,
        exportToken: "valid",
        exportNonce: thirdNonce,
      }),
    ).toBeNull();
  });

  it("runs upstream validation before issuing nonces or rate-limit checks", () => {
    upstream.mockReturnValueOnce({
      status: 403,
      reason: "bad export token",
    });
    const guard = createHardenedExportGuard(upstream);

    expect(
      guard(request(), {
        confirm: true,
        exportToken: "invalid",
        requestNonce: true,
      }),
    ).toEqual({
      status: 403,
      reason: "bad export token",
    });
    expect(getWalletExportAuditLog().at(-1)).toMatchObject({
      outcome: "rejected",
      reason: "bad export token",
    });
  });
});

/** Guards the packaged desktop session lifecycle against retry storms. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadOrCreateDesktopSession: vi.fn(),
  installDesktopSessionCookies: vi.fn(() => ["http://127.0.0.1:31337"]),
  cookieSet: vi.fn(() => true),
}));

vi.mock("electrobun/bun", () => ({
  Session: {
    defaultSession: { cookies: { set: mocks.cookieSet } },
    fromPartition: vi.fn(() => ({ cookies: { set: mocks.cookieSet } })),
  },
}));

vi.mock("../native/auth-bridge", () => ({
  loadOrCreateDesktopSession: mocks.loadOrCreateDesktopSession,
  installDesktopSessionCookies: mocks.installDesktopSessionCookies,
}));

vi.mock("../main-window-session", () => ({
  resolveMainWindowPartition: vi.fn(() => null),
}));

vi.mock("../logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  _resetDesktopSessionPrimeForTests,
  markDesktopSessionStale,
  primeDesktopSessionAuth,
} from "./desktop-session-prime";

const SESSION = {
  sessionId: "session",
  csrfToken: "csrf",
  expiresAt: Date.now() + 60_000,
};

describe("desktop session prime lifecycle", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    _resetDesktopSessionPrimeForTests();
  });

  it("coalesces overlapping status emissions into one proof exchange", async () => {
    let resolveSession: ((value: typeof SESSION) => void) | null = null;
    mocks.loadOrCreateDesktopSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );

    const first = primeDesktopSessionAuth(
      "http://127.0.0.1:31337",
      "http://127.0.0.1:5174",
    );
    const second = primeDesktopSessionAuth(
      "http://127.0.0.1:31337",
      "http://127.0.0.1:5174",
    );
    expect(mocks.loadOrCreateDesktopSession).toHaveBeenCalledTimes(1);
    resolveSession?.(SESSION);
    await Promise.all([first, second]);
    expect(mocks.installDesktopSessionCookies).toHaveBeenCalledTimes(1);
  });

  it("does not re-prime the same runtime until explicitly marked stale", async () => {
    mocks.loadOrCreateDesktopSession.mockResolvedValue(SESSION);
    await primeDesktopSessionAuth(
      "http://127.0.0.1:31337",
      "http://127.0.0.1:5174",
    );
    await primeDesktopSessionAuth(
      "http://127.0.0.1:31337",
      "http://127.0.0.1:5174",
    );
    expect(mocks.loadOrCreateDesktopSession).toHaveBeenCalledTimes(1);

    markDesktopSessionStale();
    await primeDesktopSessionAuth(
      "http://127.0.0.1:31337",
      "http://127.0.0.1:5174",
    );
    expect(mocks.loadOrCreateDesktopSession).toHaveBeenCalledTimes(2);
  });

  it("backs off a not-ready runtime instead of spinning", async () => {
    vi.useFakeTimers();
    mocks.loadOrCreateDesktopSession.mockResolvedValue(null);

    await primeDesktopSessionAuth(
      "http://127.0.0.1:31337",
      "http://127.0.0.1:5174",
    );
    await primeDesktopSessionAuth(
      "http://127.0.0.1:31337",
      "http://127.0.0.1:5174",
    );
    expect(mocks.loadOrCreateDesktopSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(mocks.loadOrCreateDesktopSession).toHaveBeenCalledTimes(2);
  });
});

import { beforeEach, describe, expect, test } from "vitest";
import {
  PairingCodeStore,
  PAIRING_CODE_TTL_MS,
  generatePairingCode,
} from "../src/remote/pairing-code.js";
import {
  RemoteSessionError,
  RemoteSessionService,
  type DataPlaneResolver,
} from "../src/remote/remote-session-service.js";

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
};

function fixedClock(start = 1_000_000): {
  now: () => number;
  advance: (ms: number) => void;
} {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("generatePairingCode", () => {
  test("produces a 6-digit zero-padded code", () => {
    for (let i = 0; i < 25; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe("PairingCodeStore", () => {
  test("issue → consume (happy path)", () => {
    const store = new PairingCodeStore();
    const issued = store.issue("agent");
    expect(store.consume("agent", issued.code)).toBe(true);
    // one-time use
    expect(store.consume("agent", issued.code)).toBe(false);
  });

  test("rotates on re-issue", () => {
    const store = new PairingCodeStore();
    const first = store.issue("agent");
    const second = store.issue("agent");
    expect(store.consume("agent", first.code)).toBe(false);
    expect(store.consume("agent", second.code)).toBe(true);
  });

  test("expires after TTL", () => {
    const clock = fixedClock();
    const store = new PairingCodeStore({ now: clock.now, ttlMs: 1000 });
    const issued = store.issue("agent");
    clock.advance(1001);
    expect(store.consume("agent", issued.code)).toBe(false);
  });

  test("wrong code is rejected without clearing the entry", () => {
    const store = new PairingCodeStore();
    const issued = store.issue("agent");
    expect(store.consume("agent", "000000" === issued.code ? "111111" : "000000")).toBe(false);
    expect(store.consume("agent", issued.code)).toBe(true);
  });

  test("default TTL is 5 minutes", () => {
    expect(PAIRING_CODE_TTL_MS).toBe(5 * 60 * 1000);
  });
});

const nullDataPlane: DataPlaneResolver = {
  resolve: () => ({ ingressUrl: null, reason: "data-plane-not-configured" }),
};

describe("RemoteSessionService", () => {
  let pairingCodes: PairingCodeStore;
  let service: RemoteSessionService;

  beforeEach(() => {
    pairingCodes = new PairingCodeStore();
    service = new RemoteSessionService({
      pairingCodes,
      dataPlane: nullDataPlane,
      isLocalMode: () => false,
      logger: silentLogger,
    });
  });

  test("startSession without confirmed throws", async () => {
    await expect(
      service.startSession({ requesterIdentity: "friend", confirmed: false }),
    ).rejects.toBeInstanceOf(RemoteSessionError);
  });

  test("remote-mode without code throws PAIRING_CODE_REQUIRED", async () => {
    await expect(
      service.startSession({ requesterIdentity: "friend", confirmed: true }),
    ).rejects.toMatchObject({ code: "PAIRING_CODE_REQUIRED" });
  });

  test("remote-mode with wrong code returns denied session", async () => {
    service.issuePairingCode();
    const result = await service.startSession({
      requesterIdentity: "friend",
      pairingCode: "000000",
      confirmed: true,
    });
    expect(result.status).toBe("denied");
    expect(result.ingressUrl).toBeNull();
  });

  test("remote-mode with valid code activates and returns explicit data-plane absence", async () => {
    const { code } = service.issuePairingCode();
    const result = await service.startSession({
      requesterIdentity: "friend",
      pairingCode: code,
      confirmed: true,
    });
    expect(result.status).toBe("active");
    expect(result.ingressUrl).toBeNull();
    expect(result.reason).toBe("data-plane-not-configured");
    expect(result.localMode).toBe(false);
  });

  test("codes are one-time use", async () => {
    const { code } = service.issuePairingCode();
    await service.startSession({
      requesterIdentity: "friend",
      pairingCode: code,
      confirmed: true,
    });
    const again = await service.startSession({
      requesterIdentity: "friend",
      pairingCode: code,
      confirmed: true,
    });
    expect(again.status).toBe("denied");
  });

  test("local mode skips pairing code but still requires confirmed", async () => {
    const localService = new RemoteSessionService({
      pairingCodes: new PairingCodeStore(),
      dataPlane: nullDataPlane,
      isLocalMode: () => true,
      logger: silentLogger,
    });
    const result = await localService.startSession({
      requesterIdentity: "friend",
      confirmed: true,
    });
    expect(result.status).toBe("active");
    expect(result.localMode).toBe(true);
    expect(result.ingressUrl).toBeNull();
    expect(result.reason).toBe("data-plane-not-configured");
  });

  test("data-plane resolver that returns a URL is propagated", async () => {
    const withIngress = new RemoteSessionService({
      pairingCodes: new PairingCodeStore(),
      dataPlane: {
        resolve: () => ({ ingressUrl: "vnc://host.ts.net:5900", reason: null }),
      },
      isLocalMode: () => true,
      logger: silentLogger,
    });
    const result = await withIngress.startSession({
      requesterIdentity: "friend",
      confirmed: true,
    });
    expect(result.ingressUrl).toBe("vnc://host.ts.net:5900");
    expect(result.reason).toBeNull();
  });

  test("revokeSession marks active sessions as revoked", async () => {
    const { code } = service.issuePairingCode();
    const started = await service.startSession({
      requesterIdentity: "friend",
      pairingCode: code,
      confirmed: true,
    });
    await service.revokeSession(started.sessionId);
    const active = await service.listActiveSessions();
    expect(active.find((s) => s.id === started.sessionId)).toBeUndefined();
    const session = await service.getSession(started.sessionId);
    expect(session?.status).toBe("revoked");
    expect(session?.endedAt).not.toBeNull();
  });

  test("revokeSession on unknown id throws SESSION_NOT_FOUND", async () => {
    await expect(service.revokeSession("nope")).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  test("listActiveSessions returns active + pending, excludes denied/revoked", async () => {
    const { code } = service.issuePairingCode();
    const ok = await service.startSession({
      requesterIdentity: "friend-a",
      pairingCode: code,
      confirmed: true,
    });
    // wrong code → denied
    service.issuePairingCode();
    await service.startSession({
      requesterIdentity: "friend-b",
      pairingCode: "000000",
      confirmed: true,
    });
    const active = await service.listActiveSessions();
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(ok.sessionId);
  });
});

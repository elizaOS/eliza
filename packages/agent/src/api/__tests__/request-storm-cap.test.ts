/**
 * Unit coverage for the per-session request-storm cap: real module state with
 * fake timers; requests are minimal http mocks capturing status codes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __requestStormCapBucketCountForTests,
  __resetRequestStormCapForTests,
  maybeCapRequestStorm,
} from "../request-storm-cap.ts";

function mockReq(
  headers: Record<string, string>,
  method = "GET",
  remoteAddress = "203.0.113.10",
) {
  return { method, headers, socket: { remoteAddress } } as never;
}
function mockRes() {
  const state = { status: 0, ended: false };
  return {
    state,
    writeHead(code: number) {
      state.status = code;
    },
    end() {
      state.ended = true;
    },
  } as never as import("node:http").ServerResponse & { state: typeof state };
}

describe("request storm cap", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000_000);
    __resetRequestStormCapForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("allows a legitimate burst, then caps a sustained storm with 429", () => {
    const req = mockReq({ authorization: "Bearer storm-session-token" });
    for (let i = 0; i < 80; i++) {
      expect(maybeCapRequestStorm(req, mockRes(), "/api/notifications")).toBe(
        false,
      );
    }
    const res = mockRes();
    expect(maybeCapRequestStorm(req, res, "/api/notifications")).toBe(true);
    expect(res.state.status).toBe(429);
    expect(res.state.ended).toBe(true);
  });

  it("refills over time so a backed-off client recovers", () => {
    const req = mockReq({ authorization: "Bearer refill-token" });
    for (let i = 0; i < 80; i++)
      maybeCapRequestStorm(req, mockRes(), "/api/status");
    expect(maybeCapRequestStorm(req, mockRes(), "/api/status")).toBe(true);
    vi.setSystemTime(1_000_000_000 + 2_000);
    expect(maybeCapRequestStorm(req, mockRes(), "/api/status")).toBe(false);
  });

  it("never caps bearerless requests (cookie pages, internal loopback)", () => {
    const req = mockReq({});
    for (let i = 0; i < 100; i++) {
      expect(maybeCapRequestStorm(req, mockRes(), "/api/views")).toBe(false);
    }
  });

  it("never caps streaming or media paths", () => {
    const req = mockReq({ authorization: "Bearer stream-token" });
    for (let i = 0; i < 100; i++) {
      expect(
        maybeCapRequestStorm(
          req,
          mockRes(),
          "/api/conversations/x/messages/stream",
        ),
      ).toBe(false);
    }
  });

  it("does not exempt unrelated paths that merely contain an exempt marker", () => {
    for (const pathname of ["/api/newsletter/ws-status", "/api/voiceover"]) {
      const req = mockReq({ authorization: `Bearer ${pathname}` });
      for (let i = 0; i < 80; i++) {
        expect(maybeCapRequestStorm(req, mockRes(), pathname)).toBe(false);
      }
      expect(maybeCapRequestStorm(req, mockRes(), pathname)).toBe(true);
    }
  });

  it("never caps the runtime's own self-API credential", () => {
    process.env.ELIZA_API_TOKEN = "internal-self-token";
    __resetRequestStormCapForTests();
    const req = mockReq(
      { authorization: "Bearer internal-self-token" },
      "GET",
      "127.0.0.1",
    );
    for (let i = 0; i < 200; i++) {
      expect(maybeCapRequestStorm(req, mockRes(), "/api/views")).toBe(false);
    }
    delete process.env.ELIZA_API_TOKEN;
    __resetRequestStormCapForTests();
  });

  it("does cap the self credential when it arrives from a remote peer", () => {
    process.env.ELIZA_API_TOKEN = "internal-self-token";
    __resetRequestStormCapForTests();
    const req = mockReq({ authorization: "Bearer internal-self-token" });
    for (let i = 0; i < 80; i++) {
      expect(maybeCapRequestStorm(req, mockRes(), "/api/views")).toBe(false);
    }
    expect(maybeCapRequestStorm(req, mockRes(), "/api/views")).toBe(true);
    delete process.env.ELIZA_API_TOKEN;
    __resetRequestStormCapForTests();
  });

  it("amortizes idle eviction after the session map becomes large", () => {
    for (let i = 0; i < 512; i++) {
      maybeCapRequestStorm(
        mockReq({ authorization: `Bearer session-${i}` }),
        mockRes(),
        "/api/status",
      );
    }
    expect(__requestStormCapBucketCountForTests()).toBe(512);

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    maybeCapRequestStorm(
      mockReq({ authorization: "Bearer fresh-session" }),
      mockRes(),
      "/api/status",
    );
    expect(__requestStormCapBucketCountForTests()).toBe(1);
  });

  it("isolates budgets per session", () => {
    const a = mockReq({ authorization: "Bearer session-a" });
    for (let i = 0; i < 81; i++)
      maybeCapRequestStorm(a, mockRes(), "/api/status");
    const b = mockReq({ authorization: "Bearer session-b" });
    expect(maybeCapRequestStorm(b, mockRes(), "/api/status")).toBe(false);
  });
});

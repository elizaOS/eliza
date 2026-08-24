/**
 * Unit coverage for parseDeviceFrame — the companion device trust-boundary
 * parser. Every inbound WebSocket frame crosses this boundary exactly once:
 * malformed JSON, unknown frame types, missing required fields, and mistyped
 * fields must all surface as typed COMPANION_BAD_FRAME errors so no raw JSON
 * reaches downstream handlers.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    code?: string;
    context?: unknown;
    cause?: unknown;
    constructor(
      message: string,
      opts?: { code?: string; context?: unknown; cause?: unknown },
    ) {
      super(message);
      this.code = opts?.code;
      this.context = opts?.context;
      this.cause = opts?.cause;
    }
  },
}));

import { parseDeviceFrame } from "./protocol.ts";

function expectBadFrame(raw: string, reasonPart: string): void {
  try {
    parseDeviceFrame(raw);
    expect.unreachable("expected parseDeviceFrame to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(reasonPart);
    expect((error as { code?: string }).code).toBe("COMPANION_BAD_FRAME");
    expect((error as { context?: { raw?: string } }).context?.raw).toBe(
      raw.slice(0, 256),
    );
  }
}

describe("parseDeviceFrame", () => {
  it("parses a minimal welcome frame", () => {
    expect(parseDeviceFrame(JSON.stringify({ type: "welcome" }))).toEqual({
      type: "welcome",
      protocol: undefined,
    });
  });

  it("parses a welcome frame with a protocol version", () => {
    expect(
      parseDeviceFrame(JSON.stringify({ type: "welcome", protocol: "v2" })),
    ).toEqual({ type: "welcome", protocol: "v2" });
  });

  it("parses a register frame and defaults missing capabilities to {}", () => {
    expect(
      parseDeviceFrame(JSON.stringify({ type: "register", deviceId: "d1" })),
    ).toEqual({
      type: "register",
      deviceId: "d1",
      firmware: undefined,
      capabilities: {},
    });
  });

  it("parses a register frame with firmware and capabilities", () => {
    expect(
      parseDeviceFrame(
        JSON.stringify({
          type: "register",
          deviceId: "d1",
          firmware: "0.9.0",
          capabilities: { touch: true },
        }),
      ),
    ).toEqual({
      type: "register",
      deviceId: "d1",
      firmware: "0.9.0",
      capabilities: { touch: true },
    });
  });

  it("rejects a register frame without a deviceId", () => {
    expectBadFrame(
      JSON.stringify({ type: "register" }),
      "register frame lacks deviceId",
    );
  });

  it("rejects a register frame with an empty deviceId", () => {
    expectBadFrame(
      JSON.stringify({ type: "register", deviceId: "  " }),
      "register frame lacks deviceId",
    );
  });

  it("drops a whitespace-only protocol field to undefined", () => {
    expect(
      parseDeviceFrame(JSON.stringify({ type: "welcome", protocol: "  " })),
    ).toEqual({ type: "welcome", protocol: undefined });
  });

  it("drops a whitespace-only firmware field to undefined", () => {
    const frame = parseDeviceFrame(
      JSON.stringify({ type: "register", deviceId: "d1", firmware: "\t" }),
    );
    expect(frame).toEqual({
      type: "register",
      deviceId: "d1",
      firmware: undefined,
      capabilities: {},
    });
  });

  it("drops a whitespace-only event name to undefined and rejects the frame", () => {
    expectBadFrame(
      JSON.stringify({ type: "event", event: "   " }),
      "event frame lacks event",
    );
  });

  it("parses a commandResult frame with ok true and correlated fields", () => {
    expect(
      parseDeviceFrame(
        JSON.stringify({
          type: "commandResult",
          correlationId: "c1",
          ok: true,
          mood: "happy",
          status: { battery: 80 },
        }),
      ),
    ).toEqual({
      type: "commandResult",
      correlationId: "c1",
      ok: true,
      error: undefined,
      mood: "happy",
      status: { battery: 80 },
    });
  });

  it("rejects a commandResult frame without correlationId", () => {
    expectBadFrame(
      JSON.stringify({ type: "commandResult", ok: true }),
      "commandResult lacks correlationId",
    );
  });

  it("rejects a commandResult frame with a non-boolean ok", () => {
    expectBadFrame(
      JSON.stringify({ type: "commandResult", correlationId: "c1", ok: 1 }),
      "commandResult lacks boolean ok",
    );
  });

  it("drops a non-object status field to undefined", () => {
    const frame = parseDeviceFrame(
      JSON.stringify({
        type: "commandResult",
        correlationId: "c1",
        ok: false,
        error: "boom",
        status: "not-an-object",
      }),
    );
    expect(frame).toEqual({
      type: "commandResult",
      correlationId: "c1",
      ok: false,
      error: "boom",
      mood: undefined,
      status: undefined,
    });
  });

  it("parses an event frame with data", () => {
    expect(
      parseDeviceFrame(
        JSON.stringify({ type: "event", event: "touch", data: { x: 1 } }),
      ),
    ).toEqual({
      type: "event",
      event: "touch",
      mood: undefined,
      data: { x: 1 },
    });
  });

  it("rejects an event frame without an event name", () => {
    expectBadFrame(
      JSON.stringify({ type: "event" }),
      "event frame lacks event",
    );
  });

  it("drops a non-object data field to undefined", () => {
    const frame = parseDeviceFrame(
      JSON.stringify({ type: "event", event: "mood_changed", data: 42 }),
    );
    expect(frame).toEqual({
      type: "event",
      event: "mood_changed",
      mood: undefined,
      data: undefined,
    });
  });

  it("parses a pong frame with a numeric timestamp", () => {
    expect(
      parseDeviceFrame(JSON.stringify({ type: "pong", at: 1234 })),
    ).toEqual({ type: "pong", at: 1234 });
  });

  it("omits a non-numeric pong timestamp", () => {
    expect(parseDeviceFrame(JSON.stringify({ type: "pong", at: "x" }))).toEqual(
      { type: "pong", at: undefined },
    );
  });

  it("rejects malformed JSON", () => {
    try {
      parseDeviceFrame("{not json");
      expect.unreachable("expected parseDeviceFrame to throw");
    } catch (error) {
      expect((error as Error).message).toContain("malformed JSON");
      expect((error as { code?: string }).code).toBe("COMPANION_BAD_FRAME");
      expect((error as { cause?: unknown }).cause).toBeDefined();
    }
  });

  it("rejects a non-object frame (array)", () => {
    expectBadFrame("[1,2,3]", "frame is not an object");
  });

  it("rejects a non-object frame (string)", () => {
    expectBadFrame('"hello"', "frame is not an object");
  });

  it("rejects a frame with a missing type", () => {
    expectBadFrame(JSON.stringify({ deviceId: "d1" }), "unknown frame type");
  });

  it("rejects a frame with an unknown type", () => {
    expectBadFrame(
      JSON.stringify({ type: "telemetry", value: 1 }),
      "unknown frame type telemetry",
    );
  });

  it("rejects a frame whose type is not a string", () => {
    expectBadFrame(JSON.stringify({ type: 7 }), "unknown frame type");
  });
});

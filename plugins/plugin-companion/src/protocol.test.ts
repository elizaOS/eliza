/**
 * Unit coverage for the ESP32 companion device frame parser — the trust
 * boundary where raw WebSocket JSON becomes a typed frame. Malformed input
 * must be rejected with a typed COMPANION_BAD_FRAME ElizaError, never
 * silently coerced into a well-typed frame.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", () => ({
  ElizaError: class ElizaError extends Error {
    code?: string;
    context?: unknown;
    constructor(
      message: string,
      opts?: { code?: string; context?: unknown; cause?: unknown },
    ) {
      super(message);
      this.code = opts?.code;
      this.context = opts?.context;
    }
  },
}));

import { ElizaError } from "@elizaos/core";
import {
  type CommandResultFrame,
  type EventFrame,
  parseDeviceFrame,
  type RegisterFrame,
  type WelcomeFrame,
} from "./protocol";

function expectBadFrame(raw: string, reasonPart: string): void {
  let thrown: unknown;
  try {
    parseDeviceFrame(raw);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ElizaError);
  const err = thrown as ElizaError;
  expect(err.code).toBe("COMPANION_BAD_FRAME");
  expect(String(err.message)).toContain(reasonPart);
}

describe("parseDeviceFrame", () => {
  it("parses a welcome frame", () => {
    const frame = parseDeviceFrame('{"type":"welcome","protocol":"1.0"}');
    expect(frame.type).toBe("welcome");
    expect((frame as WelcomeFrame).protocol).toBe("1.0");
  });

  it("parses a register frame with deviceId", () => {
    const frame = parseDeviceFrame(
      '{"type":"register","deviceId":"esp32-1","firmware":"2.1","capabilities":{"touch":true}}',
    );
    expect(frame.type).toBe("register");
    const reg = frame as RegisterFrame;
    expect(reg.deviceId).toBe("esp32-1");
    expect(reg.firmware).toBe("2.1");
    expect(reg.capabilities).toEqual({ touch: true });
  });

  it("rejects a register frame without deviceId", () => {
    expectBadFrame('{"type":"register","firmware":"2.1"}', "deviceId");
  });

  it("parses a commandResult frame", () => {
    const frame = parseDeviceFrame(
      '{"type":"commandResult","correlationId":"c-1","ok":true,"mood":"calm"}',
    );
    expect(frame.type).toBe("commandResult");
    const res = frame as CommandResultFrame;
    expect(res.correlationId).toBe("c-1");
    expect(res.ok).toBe(true);
    expect(res.mood).toBe("calm");
  });

  it("rejects a commandResult frame without correlationId", () => {
    expectBadFrame('{"type":"commandResult","ok":true}', "correlationId");
  });

  it("rejects a commandResult frame whose ok is not boolean", () => {
    expectBadFrame(
      '{"type":"commandResult","correlationId":"c-1","ok":"yes"}',
      "boolean ok",
    );
  });

  it("parses an event frame", () => {
    const frame = parseDeviceFrame(
      '{"type":"event","event":"touch","mood":"happy","data":{"x":1}}',
    );
    expect(frame.type).toBe("event");
    const ev = frame as EventFrame;
    expect(ev.event).toBe("touch");
    expect(ev.mood).toBe("happy");
    expect(ev.data).toEqual({ x: 1 });
  });

  it("rejects an event frame without an event name", () => {
    expectBadFrame('{"type":"event","mood":"happy"}', "event name");
  });

  it("parses a pong frame", () => {
    const frame = parseDeviceFrame('{"type":"pong","at":1234}');
    expect(frame.type).toBe("pong");
  });

  it("rejects malformed JSON", () => {
    expectBadFrame("{not json", "malformed JSON");
  });

  it("rejects a frame that is not an object", () => {
    expectBadFrame('["welcome"]', "not an object");
    expectBadFrame('"welcome"', "not an object");
    expectBadFrame("null", "not an object");
  });

  it("rejects an unknown frame type", () => {
    expectBadFrame('{"type":"telemetry","value":1}', "unknown frame type");
  });

  it("rejects a frame with a missing type field", () => {
    expectBadFrame('{"protocol":"1.0"}', "unknown frame type");
  });
});

/**
 * Even Realities G1 encoder tests pin fixed command opcodes and sequence byte
 * wrapping for BLE packets.
 */
import { describe, expect, it } from "vitest";
import {
  encodeBatteryStatusRequest,
  encodeBrightness,
  encodeClearScreen,
  encodeConnectionReady,
  encodeExitFunction,
  encodeHeartbeat,
  encodeMicCommand,
  encodeSilentMode,
} from "./smartglasses.js";

const bytes = (u: Uint8Array): number[] => Array.from(u);

describe("fixed-shape encoders", () => {
  it("heartbeat embeds the wrapped sequence twice", () => {
    expect(bytes(encodeHeartbeat(0x12))).toEqual([
      0x25, 0x06, 0x00, 0x12, 0x04, 0x12,
    ]);
    // sequence wraps to a byte.
    expect(bytes(encodeHeartbeat(0x100))).toEqual([
      0x25, 0x06, 0x00, 0x00, 0x04, 0x00,
    ]);
  });

  it("battery / exit are constant opcodes", () => {
    expect(bytes(encodeBatteryStatusRequest())).toEqual([0x2c, 0x01]);
    expect(bytes(encodeExitFunction())).toEqual([0x18]);
  });

  it("silent mode toggles the second byte under opcode 0x03", () => {
    const on = bytes(encodeSilentMode(true));
    const off = bytes(encodeSilentMode(false));
    expect(on[0]).toBe(0x03);
    expect(off[0]).toBe(0x03);
    expect(on[2]).toBe(0x00);
    expect(on[1]).not.toBe(off[1]);
  });

  it("mic command uses opcode 0x0e and flips the enable byte", () => {
    const on = bytes(encodeMicCommand(true));
    const off = bytes(encodeMicCommand(false));
    expect(on[0]).toBe(0x0e);
    expect(off[0]).toBe(0x0e);
    expect(on[1]).not.toBe(off[1]);
  });
});

describe("encodeBrightness", () => {
  it("encodes level + auto flag", () => {
    expect(bytes(encodeBrightness(0x10, true))).toEqual([0x01, 0x10, 0x01]);
    expect(bytes(encodeBrightness(0x00, false))).toEqual([0x01, 0x00, 0x00]);
    expect(bytes(encodeBrightness(0x29))).toEqual([0x01, 0x29, 0x00]);
  });

  it("rejects out-of-range / non-integer levels", () => {
    expect(() => encodeBrightness(0x2a)).toThrow(RangeError);
    expect(() => encodeBrightness(-1)).toThrow(RangeError);
    expect(() => encodeBrightness(1.5)).toThrow(RangeError);
  });
});

describe("encodeConnectionReady", () => {
  it("selects Init (0x4d) vs RightInit (0xf4) by side and mode", () => {
    expect(bytes(encodeConnectionReady("left"))).toEqual([0x4d, 0x01]);
    expect(bytes(encodeConnectionReady("right"))).toEqual([0xf4, 0x01]);
    // 'official' forces Init regardless of side.
    expect(bytes(encodeConnectionReady("right", "official"))).toEqual([
      0x4d, 0x01,
    ]);
    // 'android-f4' forces RightInit.
    expect(bytes(encodeConnectionReady("left", "android-f4"))).toEqual([
      0xf4, 0x01,
    ]);
  });
});

describe("encodeClearScreen", () => {
  it("is a 5-byte StartAi (0xf5) stop frame", () => {
    const out = bytes(encodeClearScreen());
    expect(out).toHaveLength(5);
    expect(out[0]).toBe(0xf5);
    expect(out.slice(2)).toEqual([0x00, 0x00, 0x00]);
  });
});

import { describe, expect, it } from "vitest";
import { buildCommand, buildPing, normalizeMood, parseFrame, withPairingToken } from "../protocol";

describe("companion protocol", () => {
  it("parses register payloads", () => {
    const frame = parseFrame(
      JSON.stringify({
        type: "register",
        payload: {
          deviceId: "S3-46BEAC",
          pairingToken: "eliza-companion-dev",
          firmware: "eliza-companion/0.1.0",
          capabilities: { platform: "esp32-s3" },
        },
      })
    );
    expect(frame?.type).toBe("register");
    if (frame?.type === "register") {
      expect(frame.payload.deviceId).toBe("S3-46BEAC");
      expect(frame.payload.capabilities?.platform).toBe("esp32-s3");
    }
  });

  it("ignores non-json console noise", () => {
    expect(parseFrame("I (123) eliza_companion: boot")).toBeNull();
    expect(parseFrame("not-json")).toBeNull();
  });

  it("normalizes mood aliases and rejects unknown moods", () => {
    expect(normalizeMood("READY")).toBe("happy");
    expect(normalizeMood("thinking")).toBe("thinking");
    expect(normalizeMood("angry")).toBeNull();
  });

  it("builds ping and SET_MOOD command frames", () => {
    expect(buildPing(123)).toEqual({ type: "ping", at: 123 });
    expect(buildCommand("SET_MOOD", "corr-1", { mood: "thinking" })).toEqual({
      type: "command",
      name: "SET_MOOD",
      correlationId: "corr-1",
      payload: { mood: "thinking" },
    });
  });

  it("appends pairing token to the websocket query", () => {
    expect(withPairingToken("ws://192.168.4.1:8080/api/companion/device-bridge", "secret")).toBe(
      "ws://192.168.4.1:8080/api/companion/device-bridge?token=secret"
    );
  });
});

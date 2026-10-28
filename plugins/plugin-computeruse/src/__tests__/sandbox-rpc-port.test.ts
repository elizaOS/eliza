import { describe, expect, it } from "vitest";
import { parseSandboxRpcPort } from "../services/computer-use-service.js";

describe("sandbox RPC port configuration", () => {
  it("preserves valid numeric settings and reserves the default for unset values", () => {
    expect(parseSandboxRpcPort(undefined)).toBeUndefined();
    expect(parseSandboxRpcPort(" ")).toBeUndefined();
    for (const [raw, port] of [
      ["1", 1],
      ["65535", 65535],
      [" 8080 ", 8080],
      ["1e3", 1000],
      ["0x50", 80],
    ] as const) {
      expect(parseSandboxRpcPort(raw)).toBe(port);
    }
  });

  it("reports an invalid explicit port instead of connecting to the default endpoint", () => {
    for (const raw of [
      "0",
      "-1",
      "65536",
      "80.5",
      "8080junk",
      "NaN",
      "Infinity",
      "9007199254740992",
    ]) {
      expect(() => parseSandboxRpcPort(raw)).toThrow(
        expect.objectContaining({ code: "INVALID_SANDBOX_RPC_PORT" }),
      );
    }
  });
});

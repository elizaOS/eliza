/**
 * W1-026 password-gate contract for the real `exportAgent` / `importAgent`:
 * passwords below the 12-character minimum are rejected before any adapter or
 * file bytes are touched, and a 12-character password passes the gate (proven
 * by reaching the NEXT validation failure on a shim runtime with no adapter).
 * Deterministic; no database or filesystem involved.
 */
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { exportAgent, importAgent } from "./agent-export.ts";

const BELOW_MIN = "12345678901"; // 11 chars — just under the minimum
const AT_MIN = "123456789012"; // 12 chars — exactly the minimum

const adapterlessRuntime = { adapter: undefined } as unknown as AgentRuntime;

describe("agent-export password minimum (W1-026)", () => {
  it("exportAgent rejects a password below 12 characters", async () => {
    await expect(
      exportAgent(adapterlessRuntime, BELOW_MIN, {}),
    ).rejects.toThrow(
      /at least 12 characters is required to encrypt the export/,
    );
    await expect(exportAgent(adapterlessRuntime, "", {})).rejects.toThrow(
      /at least 12 characters/,
    );
  });

  it("exportAgent accepts a 12-character password (passes the password gate)", async () => {
    // The shim has no adapter, so reaching the adapter check proves the
    // password was accepted.
    await expect(exportAgent(adapterlessRuntime, AT_MIN, {})).rejects.toThrow(
      /No database adapter/,
    );
  });

  it("importAgent rejects a password below 12 characters", async () => {
    await expect(
      importAgent(adapterlessRuntime, Buffer.from("x"), BELOW_MIN),
    ).rejects.toThrow(
      /at least 12 characters is required to decrypt the import/,
    );
  });

  it("importAgent accepts a 12-character password (passes the password gate)", async () => {
    await expect(
      importAgent(adapterlessRuntime, Buffer.from("x"), AT_MIN),
    ).rejects.toThrow(/No database adapter/);
  });
});

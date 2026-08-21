/**
 * Exercises cloud-agent bridge result shaping without booting a full runtime.
 * The deployed image relies on these helpers to preserve model failure
 * discriminators across the native JSON-RPC bridge.
 */

import { describe, expect, it } from "vitest";
import {
  appendBridgeCallbackContent,
  type BridgeMessageResult,
  bridgeResultText,
  checkRuntimeDatabaseLiveness,
  publicDatabaseLiveness,
} from "./cloud-agent-shared";

describe("cloud-agent bridge callback results", () => {
  it("accumulates text while preserving the runtime failure discriminator", () => {
    const result: BridgeMessageResult = { text: "" };

    appendBridgeCallbackContent(result, { text: "provider " });
    appendBridgeCallbackContent(result, {
      text: "unavailable",
      failureKind: "provider_issue",
    });
    appendBridgeCallbackContent(result, {
      text: " ignored discriminator",
      failureKind: "rate_limited",
    });

    expect(result).toEqual({
      text: "provider unavailable ignored discriminator",
      failureKind: "provider_issue",
    });
  });

  it("uses the native no-response text without dropping failureKind", () => {
    const result: BridgeMessageResult = { text: "" };

    appendBridgeCallbackContent(result, { failureKind: "no_response" });

    expect(bridgeResultText(result)).toBe("(no response)");
    expect(result.failureKind).toBe("no_response");
  });
});

describe("cloud-agent database liveness", () => {
  it("omits exception detail from the public health projection", () => {
    const marker = "password=secret at /srv/database.ts:42";

    expect(
      publicDatabaseLiveness({
        ok: false,
        status: "terminal_error",
        terminal: true,
        message: marker,
      }),
    ).toEqual({
      ok: false,
      status: "terminal_error",
      terminal: true,
    });
  });

  it("classifies a real queryable closed-PGlite error as terminal", async () => {
    await expect(
      checkRuntimeDatabaseLiveness({
        adapter: {
          getRawConnection: () => ({
            async query() {
              throw new Error("PGlite is closed");
            },
          }),
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "terminal_error",
      terminal: true,
      message: "PGlite is closed",
    });
  });

  it("preserves terminal closure from a DB handle even when isReady collapses it", async () => {
    await expect(
      checkRuntimeDatabaseLiveness({
        adapter: {
          isReady: async () => false,
          db: {
            async execute() {
              throw new Error("Database is shutting down - operation rejected");
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "terminal_error",
      terminal: true,
    });
  });

  it("classifies bounded non-terminal probe failures separately", async () => {
    await expect(
      checkRuntimeDatabaseLiveness({
        adapter: {
          async getConnection() {
            return {
              async execute() {
                throw new Error("probe timeout");
              },
            };
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: "transient_error",
      terminal: false,
      message: "probe timeout",
    });
  });
});

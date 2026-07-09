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

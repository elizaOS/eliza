/** Verifies deterministic device-e2e model routing without starting an agent or server. */

import { describe, expect, it } from "vitest";
import {
  resolveDeviceE2eModelCall,
  STREAM_E2E_REPLY,
} from "./device-e2e-model-resolver";

describe("resolveDeviceE2eModelCall", () => {
  it("answers the conversation-title side call accepted by the real chat API", () => {
    expect(
      resolveDeviceE2eModelCall({
        modelType: "TEXT_SMALL",
        latestUserText:
          "Based on the user's first message, generate a very short, concise title. Title:",
      }),
    ).toEqual({ message: "Short greeting" });
  });

  it("does not fabricate answers for unrelated text-small calls", () => {
    expect(
      resolveDeviceE2eModelCall({
        modelType: "TEXT_SMALL",
        latestUserText: "Summarize this private document.",
      }),
    ).toBeNull();
  });

  it("returns the device chat fixture through the response-handler slot", () => {
    const result = resolveDeviceE2eModelCall({
      modelType: "RESPONSE_HANDLER",
    });
    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string)).toMatchObject({
      shouldRespond: "RESPOND",
      replyText: STREAM_E2E_REPLY,
    });
  });

  it("keeps the workflow-only large-model fixture opt-in", () => {
    expect(resolveDeviceE2eModelCall({ modelType: "TEXT_LARGE" })).toBeNull();
    expect(
      resolveDeviceE2eModelCall(
        { modelType: "TEXT_LARGE" },
        { workflowJourney: true },
      ),
    ).toEqual({ message: "Digest ready" });
  });
});

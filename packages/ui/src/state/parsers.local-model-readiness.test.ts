/** Validates the remote status boundary for an unloaded, runtime-owned local text model. */
import { describe, expect, it } from "vitest";
import { parseAgentStatusEvent } from "./parsers";

describe("local text model status", () => {
  it("retains a known unloaded status and ignores unrecognized provider claims", () => {
    const status = parseAgentStatusEvent({
      state: "running",
      agentName: "Eliza",
      canRespond: false,
      localModelReadiness: {
        provider: "eliza-local-inference",
        status: "model_not_loaded",
      },
    });
    expect(status?.localModelReadiness).toEqual({
      provider: "eliza-local-inference",
      status: "model_not_loaded",
    });
    expect(
      parseAgentStatusEvent({
        state: "running",
        agentName: "Eliza",
        localModelReadiness: {
          provider: "untrusted-provider",
          status: "model_not_loaded",
        },
      })?.localModelReadiness,
    ).toBeUndefined();
  });
});

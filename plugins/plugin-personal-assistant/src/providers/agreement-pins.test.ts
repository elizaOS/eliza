/**
 * Deterministic provider coverage proving that planner context contains only
 * approved obligations selected by active agent/chat pins and that an empty
 * pin set contributes no agreement instructions.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { agreementPinsProvider } from "./agreement-pins.js";

function runtimeWithViews(views: unknown[]) {
  const activePinnedContext = vi.fn(async () => views);
  return {
    runtime: {
      getService: vi.fn(() => ({ agreements: { activePinnedContext } })),
    } as unknown as IAgentRuntime,
    activePinnedContext,
  };
}

describe("agreementPinsProvider", () => {
  it("injects the complete approved citation for matching room pins", async () => {
    const { runtime, activePinnedContext } = runtimeWithViews([
      {
        artifact: {
          id: "artifact-1",
          title: "Parenting plan",
          version: 3,
          contentSha256: "abc123",
        },
        obligations: [
          {
            title: "School notice",
            obligationText: "Share every school notice within 24 hours.",
            pageStart: 4,
            pageEnd: 5,
            citationText: "Each parent shall forward every school notice.",
            status: "approved",
          },
        ],
      },
    ]);
    const result = await agreementPinsProvider.get(
      runtime,
      { roomId: "family-chat" } as Memory,
      {} as never,
    );
    expect(activePinnedContext).toHaveBeenCalledWith({
      ownerEntityId: "self",
      roomId: "family-chat",
    });
    expect(result.text).toContain("Share every school notice within 24 hours.");
    expect(result.text).toContain("source pages 4-5");
    expect(result.text).toContain(
      "Each parent shall forward every school notice.",
    );
    expect(result.values).toMatchObject({
      agreementPinCount: 1,
      approvedAgreementObligationCount: 1,
    });
  });

  it("is quiet when there are no active approved pins", async () => {
    const { runtime } = runtimeWithViews([]);
    await expect(
      agreementPinsProvider.get(
        runtime,
        { roomId: "other-chat" } as Memory,
        {} as never,
      ),
    ).resolves.toMatchObject({
      text: "",
      values: { agreementPinCount: 0 },
    });
  });
});

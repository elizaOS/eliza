/**
 * Deterministic provider coverage proving that planner context contains only
 * approved obligations selected by active agent/chat pins and that an empty
 * pin set contributes no agreement instructions.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { agreementPinsProvider } from "./agreement-pins.js";

const mocks = vi.hoisted(() => ({ hasOwnerAccess: vi.fn() }));

vi.mock("@elizaos/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@elizaos/agent")>()),
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

function runtimeWithViews(views: unknown[]) {
  const activePinnedContextForPrincipal = vi.fn(async () => views);
  return {
    runtime: {
      getService: vi.fn(() => ({
        agreements: { activePinnedContextForPrincipal },
      })),
    } as unknown as IAgentRuntime,
    activePinnedContextForPrincipal,
  };
}

describe("agreementPinsProvider", () => {
  it("injects the complete approved citation for matching room pins", async () => {
    mocks.hasOwnerAccess.mockResolvedValueOnce(true);
    const { runtime, activePinnedContextForPrincipal } = runtimeWithViews([
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
    expect(activePinnedContextForPrincipal).toHaveBeenCalledWith({
      principalEntityId: "self",
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
    mocks.hasOwnerAccess.mockResolvedValueOnce(true);
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

  it("resolves a guest against their Entity and never injects owner-only digest metadata", async () => {
    mocks.hasOwnerAccess.mockResolvedValueOnce(false);
    const { runtime, activePinnedContextForPrincipal } = runtimeWithViews([
      {
        artifact: {
          id: "artifact-1",
          title: "Parenting plan",
          version: 3,
          originalFilename: "plan.pdf",
          mimeType: "application/pdf",
          byteSize: 100,
          pageCount: 5,
          createdAt: "2026-01-01T00:00:00.000Z",
        },
        obligations: [
          {
            id: "obligation-1",
            title: "School notice",
            obligationText: "Share every school notice within 24 hours.",
            pageStart: 4,
            pageEnd: 5,
            citationText: "Each parent shall forward every school notice.",
            status: "approved",
            decidedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
    ]);
    const result = await agreementPinsProvider.get(
      runtime,
      { entityId: "verified-co-parent", roomId: "family-chat" } as Memory,
      {} as never,
    );
    expect(activePinnedContextForPrincipal).toHaveBeenCalledWith({
      principalEntityId: "verified-co-parent",
      roomId: "family-chat",
    });
    expect(result.text).toContain("Share every school notice within 24 hours.");
    expect(result.text).not.toContain("SHA-256");
    expect(result.data).not.toHaveProperty(
      "agreements.0.artifact.contentSha256",
    );
  });
});

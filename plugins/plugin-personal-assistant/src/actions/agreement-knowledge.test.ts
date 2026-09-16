/**
 * Deterministic chat-action coverage for agreement access previews. The test
 * proves the action selects the canonical service, fixes the actor to owner,
 * and returns the domain's machine-readable permission effects unchanged.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { ownerAgreementKnowledgeAction } from "./agreement-knowledge.js";

describe("OWNER_AGREEMENT_KNOWLEDGE", () => {
  it("previews bounded guest effects without issuing access", async () => {
    const previewGuestRead = vi.fn(async () => ({
      allowed: true,
      effects: ["read_artifact_metadata", "read_approved_obligations"],
      exclusions: [
        "read_proposed_or_rejected_obligations",
        "mutate_agreement",
        "inherit_access_from_pin",
      ],
      denial: null,
    }));
    const runtime = {
      getService: vi.fn(() => ({ agreements: { previewGuestRead } })),
    } as unknown as IAgentRuntime;
    const result = await ownerAgreementKnowledgeAction.handler?.(
      runtime,
      { entityId: "self" } as Memory,
      undefined,
      {
        parameters: {
          action: "preview_guest_grant",
          artifactId: "artifact-1",
          principalEntityId: "guest-1",
          householdGrantId: "household-grant-1",
        },
      },
      undefined,
    );
    expect(previewGuestRead).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      principalEntityId: "guest-1",
      householdGrantId: "household-grant-1",
      ownerEntityId: "self",
    });
    expect(result).toMatchObject({
      success: true,
      data: {
        action: "preview_guest_grant",
        result: {
          effects: ["read_artifact_metadata", "read_approved_obligations"],
          exclusions: [
            "read_proposed_or_rejected_obligations",
            "mutate_agreement",
            "inherit_access_from_pin",
          ],
        },
      },
    });
  });
});

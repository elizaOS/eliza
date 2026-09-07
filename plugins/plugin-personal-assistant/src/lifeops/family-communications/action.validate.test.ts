/**
 * FAMILY_COMMUNICATIONS advertisement gate: the action validates only while its
 * runtime service is live and the caller is an authenticated principal, so a
 * service that failed to start is never offered to the planner. Deps are
 * deterministic doubles; no database.
 */
import type { IAgentRuntime, Memory } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { createFamilyCommunicationsAction } from "./action.js";
import type { FamilyCommunicationsService } from "./service.js";

const runtime = { getService: () => null } as unknown as IAgentRuntime;
const message = { content: { text: "plan the kids' week" } } as Memory;

function action(overrides: {
  service: FamilyCommunicationsService | null;
  principal?: string | null;
}) {
  return createFamilyCommunicationsAction({
    resolveAuthenticatedPrincipal: async () =>
      overrides.principal === undefined ? SELF_ENTITY_ID : overrides.principal,
    issueSpeakerAttestation: async () => {
      throw new Error("not used");
    },
    resolveWeekItems: async () => [],
    getService: () => overrides.service,
  });
}

describe("FAMILY_COMMUNICATIONS validate", () => {
  it("does not advertise the action while its service is unavailable", async () => {
    // Live 2026-09-05: the service failed its boot-time start, the planner
    // still selected the action, and the handler threw after a full tool stage.
    expect(await action({ service: null }).validate(runtime, message)).toBe(
      false,
    );
  });

  it("advertises the action for an authenticated principal once the service is live", async () => {
    const service = {} as FamilyCommunicationsService;
    expect(await action({ service }).validate(runtime, message)).toBe(true);
    expect(
      await action({ service, principal: null }).validate(runtime, message),
    ).toBe(false);
  });
});

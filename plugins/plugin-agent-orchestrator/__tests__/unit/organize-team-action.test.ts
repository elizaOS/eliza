/** Verifies the autonomous-organization action boundary, host opt-in, identity checks, and stable kickoff forwarding. */

import type { Memory, UUID } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/core/testing";
import { describe, expect, it, vi } from "vitest";
import { organizeTeamAction } from "../../src/actions/organize-team.js";

const requestId = "11111111-2222-4333-8444-555555555555" as UUID;
const sponsorId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" as UUID;

function message(overrides: Partial<Memory> = {}): Memory {
  return {
    id: requestId,
    entityId: sponsorId,
    agentId: "99999999-8888-4777-8666-555555555555" as UUID,
    roomId: "12345678-1234-4234-8234-123456789abc" as UUID,
    content: { text: "Fallback objective" },
    ...overrides,
  };
}

describe("ORGANIZE_TEAM", () => {
  it("stays unavailable until the host explicitly enables coding organizations", async () => {
    const runtime = createMockRuntime({
      getSetting: () => undefined,
      getService: () => ({ startOrganization: vi.fn() }),
    });

    expect(await organizeTeamAction.validate(runtime, message())).toBe(false);
    await expect(
      organizeTeamAction.handler(runtime, message()),
    ).resolves.toMatchObject({
      success: false,
      error: "ORGANIZATION_EXECUTION_NOT_AUTHORIZED",
    });
  });

  it("forwards one explicit objective with stable request and sponsor identity", async () => {
    const startOrganization = vi.fn(async () => ({
      revision: 7,
      organization: {
        id: "organization-1",
        name: "Delivery team",
        status: "active" as const,
        members: [{ id: "coordinator" }, { id: "analyst" }],
        workItems: [{ id: "analysis", status: "in_progress" as const }],
      },
    }));
    const runtime = createMockRuntime({
      getSetting: (key) =>
        key === "ELIZA_ENABLE_AUTONOMOUS_ORGANIZATIONS" ? "true" : undefined,
      getService: () => ({ startOrganization }),
    });

    const result = await organizeTeamAction.handler(
      runtime,
      message(),
      undefined,
      { parameters: { objective: "Explicit complete objective" } },
    );

    expect(startOrganization).toHaveBeenCalledWith({
      requestId,
      sponsorPrincipalId: sponsorId,
      objective: "Explicit complete objective",
    });
    expect(result).toMatchObject({
      success: true,
      text: expect.stringContaining("is active"),
      data: { organizationId: "organization-1", revision: 7 },
    });
  });

  it("rejects messages without stable request or sponsor identity", async () => {
    const runtime = createMockRuntime({
      getSetting: () => true,
      getService: () => ({ startOrganization: vi.fn() }),
    });

    await expect(
      organizeTeamAction.handler(
        runtime,
        message({ id: undefined, entityId: undefined }),
      ),
    ).resolves.toMatchObject({
      success: false,
      error: "ORGANIZATION_REQUEST_IDENTITY_REQUIRED",
    });
  });
});

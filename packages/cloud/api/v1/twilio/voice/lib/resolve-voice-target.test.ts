/**
 * Proves Twilio calls resolve only through the exact configured public line.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface SandboxRow {
  id: string;
  organization_id: string;
  user_id: string;
  character_id: string | null;
  agent_name: string | null;
  agent_config: Record<string, unknown> | null;
  execution_tier: "shared";
}

function sandboxRow(id: string): SandboxRow {
  return {
    id,
    organization_id: "org-public",
    user_id: "user-public",
    character_id: "character-public",
    agent_name: "Eliza",
    agent_config: null,
    execution_tier: "shared",
  };
}

const findById = mock(
  async (_agentId: string): Promise<SandboxRow | null> => null,
);
const findLatestByCharacterId = mock(
  async (_characterId: string): Promise<SandboxRow | null> => null,
);

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findById,
    findLatestByCharacterId,
  },
}));

const { resolveTwilioVoiceTarget } = await import("./resolve-voice-target");

const PUBLIC_NUMBER = "+14484080429";
const DEFAULT_AGENT_ID = "agent-public";
const publicEnv = {
  ELIZA_APP_DEFAULT_AGENT_ID: DEFAULT_AGENT_ID,
  ELIZA_APP_TWILIO_PHONE_NUMBER: PUBLIC_NUMBER,
};

beforeEach(() => {
  findById.mockClear();
  findLatestByCharacterId.mockClear();
  findById.mockImplementation(async () => null);
  findLatestByCharacterId.mockImplementation(async () => null);
});

describe("resolveTwilioVoiceTarget", () => {
  test("resolves the exact public number to the configured sandbox", async () => {
    const agent = sandboxRow(DEFAULT_AGENT_ID);
    findById.mockImplementation(async () => agent);

    await expect(
      resolveTwilioVoiceTarget(publicEnv, PUBLIC_NUMBER),
    ).resolves.toEqual({
      agent: agent as never,
      agentId: DEFAULT_AGENT_ID,
      organizationId: "org-public",
      userId: "user-public",
    });
    expect(findLatestByCharacterId).not.toHaveBeenCalled();
  });

  test("supports a legacy character id for the configured public agent", async () => {
    const agent = sandboxRow("agent-from-character");
    findLatestByCharacterId.mockImplementation(async () => agent);

    await expect(
      resolveTwilioVoiceTarget(publicEnv, PUBLIC_NUMBER),
    ).resolves.toEqual({
      agent: agent as never,
      agentId: "agent-from-character",
      organizationId: "org-public",
      userId: "user-public",
    });
    expect(findLatestByCharacterId).toHaveBeenCalledWith(DEFAULT_AGENT_ID);
  });

  test("refuses fallback for every number except the configured public line", async () => {
    await expect(
      resolveTwilioVoiceTarget(publicEnv, "+12525914471"),
    ).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
    expect(findLatestByCharacterId).not.toHaveBeenCalled();
  });
});

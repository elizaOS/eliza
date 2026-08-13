/**
 * Proves Twilio calls resolve only through an active tenant binding or the
 * exact configured public Eliza line, using deterministic repository doubles.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

interface SandboxRow {
  id: string;
  organization_id: string;
  user_id: string;
}

let mappingRows: Array<{ agentId: string; organizationId: string }> = [];
const findByIdAndOrg = mock(
  async (
    _agentId: string,
    _organizationId: string,
  ): Promise<SandboxRow | null> => null,
);
const findById = mock(
  async (_agentId: string): Promise<SandboxRow | null> => null,
);
const findLatestByCharacterId = mock(
  async (_characterId: string): Promise<SandboxRow | null> => null,
);

const dbRead = {
  select: mock(() => ({
    from: () => ({
      where: () => ({
        limit: async () => mappingRows,
      }),
    }),
  })),
};

mock.module("@/db/helpers", () => ({ dbRead }));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findById,
    findByIdAndOrg,
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
  mappingRows = [];
  dbRead.select.mockClear();
  findById.mockClear();
  findByIdAndOrg.mockClear();
  findLatestByCharacterId.mockClear();
  findById.mockImplementation(async () => null);
  findByIdAndOrg.mockImplementation(async () => null);
  findLatestByCharacterId.mockImplementation(async () => null);
});

describe("resolveTwilioVoiceTarget", () => {
  test("prefers an explicit tenant binding over the public fallback", async () => {
    mappingRows = [{ agentId: "agent-tenant", organizationId: "org-tenant" }];
    findByIdAndOrg.mockImplementation(async () => ({
      id: "agent-tenant",
      organization_id: "org-tenant",
      user_id: "user-tenant",
    }));

    await expect(
      resolveTwilioVoiceTarget(publicEnv, PUBLIC_NUMBER),
    ).resolves.toEqual({
      agentId: "agent-tenant",
      organizationId: "org-tenant",
      userId: "user-tenant",
    });
    expect(findByIdAndOrg).toHaveBeenCalledWith("agent-tenant", "org-tenant");
    expect(findById).not.toHaveBeenCalled();
  });

  test("does not fall through when an explicit binding points at no sandbox", async () => {
    mappingRows = [{ agentId: "agent-missing", organizationId: "org-tenant" }];

    await expect(
      resolveTwilioVoiceTarget(publicEnv, PUBLIC_NUMBER),
    ).resolves.toBeNull();
    expect(findById).not.toHaveBeenCalled();
    expect(findLatestByCharacterId).not.toHaveBeenCalled();
  });

  test("resolves the exact public number to the configured sandbox", async () => {
    findById.mockImplementation(async () => ({
      id: DEFAULT_AGENT_ID,
      organization_id: "org-public",
      user_id: "user-public",
    }));

    await expect(
      resolveTwilioVoiceTarget(publicEnv, PUBLIC_NUMBER),
    ).resolves.toEqual({
      agentId: DEFAULT_AGENT_ID,
      organizationId: "org-public",
      userId: "user-public",
    });
    expect(findLatestByCharacterId).not.toHaveBeenCalled();
  });

  test("supports a legacy character id for the configured public agent", async () => {
    findLatestByCharacterId.mockImplementation(async () => ({
      id: "agent-from-character",
      organization_id: "org-public",
      user_id: "user-public",
    }));

    await expect(
      resolveTwilioVoiceTarget(publicEnv, PUBLIC_NUMBER),
    ).resolves.toEqual({
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

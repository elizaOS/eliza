/**
 * Exercises managed Discord and GitHub connector mutations directly with
 * deterministic repository and provisioning-job spies. The suite proves that
 * shared or unknown runtime tiers persist configuration without scheduling a
 * container restart, while a container-backed tier keeps the restart path.
 */

import { describe, expect, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { ManagedAgentDiscordService } from "./agent-managed-discord";
import { ManagedAgentGithubService } from "./agent-managed-github";
import {
  AGENT_MANAGED_DISCORD_KEY,
  AGENT_MANAGED_GITHUB_KEY,
  type ManagedAgentDiscordBinding,
  type ManagedAgentGithubBinding,
  withManagedAgentGithubBinding,
} from "./eliza-agent-config";
import { provisioningJobService } from "./provisioning-jobs";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";

const DISCORD_BINDING: ManagedAgentDiscordBinding = {
  mode: "cloud-managed",
  applicationId: "discord-app-1",
  guildId: "discord-guild-1",
  guildName: "Managed Guild",
  adminDiscordUserId: "discord-admin-1",
  adminDiscordUsername: "managed-admin",
  adminElizaUserId: USER_ID,
  connectedAt: "2026-08-22T12:00:00.000Z",
};

const GITHUB_BINDING: ManagedAgentGithubBinding = {
  mode: "shared-owner",
  connectionId: "github-connection-1",
  githubUserId: "github-user-1",
  githubUsername: "managed-owner",
  scopes: ["repo"],
  adminElizaUserId: USER_ID,
  connectedAt: "2026-08-22T12:00:00.000Z",
  connectionRole: "owner",
  source: "platform_credentials",
};

function runningSandbox(
  executionTier: string,
  agentConfig: Record<string, unknown> = {},
): AgentSandbox {
  return {
    id: AGENT_ID,
    organization_id: ORG_ID,
    user_id: USER_ID,
    status: "running",
    execution_tier: executionTier,
    agent_config: agentConfig,
  } as unknown as AgentSandbox;
}

function installMutationSpies(sandbox: AgentSandbox) {
  const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockResolvedValue(sandbox);
  const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(sandbox);
  const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockResolvedValue(
    {} as never,
  );
  const triggerSpy = spyOn(provisioningJobService, "triggerImmediate").mockResolvedValue();

  return {
    updateSpy,
    enqueueSpy,
    triggerSpy,
    restore() {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
      triggerSpy.mockRestore();
    },
  };
}

function expectPersistedAgentConfig(
  spies: ReturnType<typeof installMutationSpies>,
): Record<string, unknown> {
  expect(spies.updateSpy).toHaveBeenCalledTimes(1);
  const updateCall = spies.updateSpy.mock.calls[0];
  expect(updateCall?.[0]).toBe(AGENT_ID);
  expect(updateCall?.[1]).toEqual({
    agent_config: expect.any(Object),
  });
  return updateCall?.[1]?.agent_config as Record<string, unknown>;
}

async function expectDiscordConnectWithoutRestart(executionTier: string): Promise<void> {
  const sandbox = runningSandbox(executionTier);
  const spies = installMutationSpies(sandbox);
  const guildLookupSpy = spyOn(
    agentSandboxesRepository,
    "findByManagedDiscordGuildId",
  ).mockResolvedValue([]);

  try {
    const result = await new ManagedAgentDiscordService().connectAgent({
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      binding: DISCORD_BINDING,
    });

    const persistedConfig = expectPersistedAgentConfig(spies);
    expect(result.restarted).toBe(false);
    expect(result.status.connected).toBe(true);
    expect(persistedConfig[AGENT_MANAGED_DISCORD_KEY]).toEqual(
      expect.objectContaining({ guildId: DISCORD_BINDING.guildId }),
    );
    expect(spies.enqueueSpy).not.toHaveBeenCalled();
    expect(spies.triggerSpy).not.toHaveBeenCalled();
  } finally {
    guildLookupSpy.mockRestore();
    spies.restore();
  }
}

async function expectDiscordDisconnectWithoutRestart(executionTier: string): Promise<void> {
  const sandbox = runningSandbox(executionTier, {
    [AGENT_MANAGED_DISCORD_KEY]: DISCORD_BINDING,
    roles: { connectorAdmins: { discord: [DISCORD_BINDING.adminDiscordUserId] } },
    env: {
      AGENT_DISCORD_OWNER_USER_IDS_JSON: JSON.stringify([DISCORD_BINDING.adminDiscordUserId]),
    },
  });
  const spies = installMutationSpies(sandbox);

  try {
    const result = await new ManagedAgentDiscordService().disconnectAgent({
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      configured: true,
      applicationId: DISCORD_BINDING.applicationId ?? null,
    });

    const persistedConfig = expectPersistedAgentConfig(spies);
    expect(result.restarted).toBe(false);
    expect(result.status.connected).toBe(false);
    expect(persistedConfig).not.toHaveProperty(AGENT_MANAGED_DISCORD_KEY);
    expect(spies.enqueueSpy).not.toHaveBeenCalled();
    expect(spies.triggerSpy).not.toHaveBeenCalled();
  } finally {
    spies.restore();
  }
}

async function expectGithubConnectWithoutRestart(executionTier: string): Promise<void> {
  const sandbox = runningSandbox(executionTier);
  const spies = installMutationSpies(sandbox);

  try {
    const result = await new ManagedAgentGithubService().connectAgent({
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      binding: GITHUB_BINDING,
    });

    const persistedConfig = expectPersistedAgentConfig(spies);
    expect(result.restarted).toBe(false);
    expect(result.status.connected).toBe(true);
    expect(persistedConfig[AGENT_MANAGED_GITHUB_KEY]).toEqual(
      expect.objectContaining({ githubUsername: GITHUB_BINDING.githubUsername }),
    );
    expect(spies.enqueueSpy).not.toHaveBeenCalled();
    expect(spies.triggerSpy).not.toHaveBeenCalled();
  } finally {
    spies.restore();
  }
}

async function expectGithubDisconnectWithoutRestart(executionTier: string): Promise<void> {
  const sandbox = runningSandbox(executionTier, withManagedAgentGithubBinding({}, GITHUB_BINDING));
  const spies = installMutationSpies(sandbox);

  try {
    const result = await new ManagedAgentGithubService().disconnectAgent({
      agentId: AGENT_ID,
      organizationId: ORG_ID,
    });

    const persistedConfig = expectPersistedAgentConfig(spies);
    expect(result.restarted).toBe(false);
    expect(result.status.connected).toBe(false);
    expect(persistedConfig).not.toHaveProperty(AGENT_MANAGED_GITHUB_KEY);
    expect(spies.enqueueSpy).not.toHaveBeenCalled();
    expect(spies.triggerSpy).not.toHaveBeenCalled();
  } finally {
    spies.restore();
  }
}

function expectRestartScheduled(
  result: { restarted: boolean },
  spies: ReturnType<typeof installMutationSpies>,
): void {
  expectPersistedAgentConfig(spies);
  expect(result.restarted).toBe(true);
  expect(spies.enqueueSpy).toHaveBeenCalledTimes(1);
  expect(spies.enqueueSpy).toHaveBeenCalledWith({
    agentId: AGENT_ID,
    organizationId: ORG_ID,
    userId: USER_ID,
  });
  expect(spies.triggerSpy).toHaveBeenCalledTimes(1);
}

async function expectDiscordConnectWithRestart(executionTier: string): Promise<void> {
  const sandbox = runningSandbox(executionTier);
  const spies = installMutationSpies(sandbox);
  const guildLookupSpy = spyOn(
    agentSandboxesRepository,
    "findByManagedDiscordGuildId",
  ).mockResolvedValue([]);

  try {
    const result = await new ManagedAgentDiscordService().connectAgent({
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      binding: DISCORD_BINDING,
    });
    expectRestartScheduled(result, spies);
  } finally {
    guildLookupSpy.mockRestore();
    spies.restore();
  }
}

async function expectDiscordDisconnectWithRestart(executionTier: string): Promise<void> {
  const sandbox = runningSandbox(executionTier, {
    [AGENT_MANAGED_DISCORD_KEY]: DISCORD_BINDING,
  });
  const spies = installMutationSpies(sandbox);

  try {
    const result = await new ManagedAgentDiscordService().disconnectAgent({
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      configured: true,
      applicationId: DISCORD_BINDING.applicationId ?? null,
    });
    expectRestartScheduled(result, spies);
  } finally {
    spies.restore();
  }
}

async function expectGithubConnectWithRestart(executionTier: string): Promise<void> {
  const sandbox = runningSandbox(executionTier);
  const spies = installMutationSpies(sandbox);

  try {
    const result = await new ManagedAgentGithubService().connectAgent({
      agentId: AGENT_ID,
      organizationId: ORG_ID,
      binding: GITHUB_BINDING,
    });
    expectRestartScheduled(result, spies);
  } finally {
    spies.restore();
  }
}

async function expectGithubDisconnectWithRestart(executionTier: string): Promise<void> {
  const sandbox = runningSandbox(executionTier, withManagedAgentGithubBinding({}, GITHUB_BINDING));
  const spies = installMutationSpies(sandbox);

  try {
    const result = await new ManagedAgentGithubService().disconnectAgent({
      agentId: AGENT_ID,
      organizationId: ORG_ID,
    });
    expectRestartScheduled(result, spies);
  } finally {
    spies.restore();
  }
}

describe("managed connector restart admission", () => {
  for (const executionTier of ["shared", "future-unknown-tier"]) {
    test(`Discord connect persists config without restart for ${executionTier}`, async () => {
      await expectDiscordConnectWithoutRestart(executionTier);
    });

    test(`Discord disconnect persists config without restart for ${executionTier}`, async () => {
      await expectDiscordDisconnectWithoutRestart(executionTier);
    });

    test(`GitHub connect persists config without restart for ${executionTier}`, async () => {
      await expectGithubConnectWithoutRestart(executionTier);
    });

    test(`GitHub disconnect persists config without restart for ${executionTier}`, async () => {
      await expectGithubDisconnectWithoutRestart(executionTier);
    });
  }

  for (const executionTier of ["dedicated-lazy", "dedicated-always", "custom"]) {
    test(`Discord connect schedules restart for ${executionTier}`, async () => {
      await expectDiscordConnectWithRestart(executionTier);
    });

    test(`Discord disconnect schedules restart for ${executionTier}`, async () => {
      await expectDiscordDisconnectWithRestart(executionTier);
    });

    test(`GitHub connect schedules restart for ${executionTier}`, async () => {
      await expectGithubConnectWithRestart(executionTier);
    });

    test(`GitHub disconnect schedules restart for ${executionTier}`, async () => {
      await expectGithubDisconnectWithRestart(executionTier);
    });
  }
});

/**
 * Connector get_user lookup tests drive the real `SlackService.getConnectorUser`
 * method with its Slack transport stubbed: a blank identifier must resolve to
 * null instead of matching an arbitrary workspace member via the substring
 * scan, while partial-name queries still resolve their intended member.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SlackService } from "./service";

type StubClient = {
  users: { list: ReturnType<typeof vi.fn> };
};

function createService(client: StubClient) {
  const service = Object.create(SlackService.prototype) as SlackService & {
    runtime: IAgentRuntime;
    defaultAccountId?: string;
    getClientForAccount: (accountId?: string | null) => StubClient | null;
    resolveSlackTargetUserId: (
      runtime: IAgentRuntime,
      lookup: string,
      accountId: string,
    ) => Promise<string | null>;
    getUser: (slackUserId: string, accountId: string) => Promise<unknown>;
    getEntityId: (userId: string, accountId: string) => string;
    getTeamIdForAccount: (accountId: string) => string | undefined;
  };
  service.runtime = {
    agentId: "00000000-0000-0000-0000-00000000agent",
  } as unknown as IAgentRuntime;
  service.getClientForAccount = vi.fn().mockReturnValue(client);
  service.resolveSlackTargetUserId = vi.fn().mockResolvedValue(null);
  service.getUser = vi.fn(async (slackUserId: string) => ({
    id: slackUserId,
    name: slackUserId,
    profile: {},
  }));
  service.getEntityId = vi.fn((userId: string) => `entity-${userId}`);
  service.getTeamIdForAccount = vi.fn().mockReturnValue(undefined);
  return service;
}

function createDirectoryClient(members: unknown[]) {
  return {
    users: {
      list: vi.fn().mockResolvedValue({ members }),
    },
  };
}

describe("getConnectorUser blank-query guard", () => {
  it("resolves null for a whitespace-only query without scanning the directory", async () => {
    const client = createDirectoryClient([
      { id: "UAAA111", name: "grace" },
      { id: "UBBB222", name: "ada-lovelace" },
    ]);
    const service = createService(client);

    const result = await (
      service as unknown as {
        getConnectorUser: (
          runtime: IAgentRuntime,
          params: { query: string },
        ) => Promise<unknown>;
      }
    ).getConnectorUser(service.runtime, { query: "   " });

    expect(result).toBeNull();
    expect(client.users.list).not.toHaveBeenCalled();
  });

  it("still resolves partial-name queries against the directory", async () => {
    const client = createDirectoryClient([
      { id: "UAAA111", name: "grace" },
      { id: "UBBB222", name: "ada-lovelace" },
    ]);
    const service = createService(client);

    const result = await (
      service as unknown as {
        getConnectorUser: (
          runtime: IAgentRuntime,
          params: { query: string },
        ) => Promise<{ id: string }>;
      }
    ).getConnectorUser(service.runtime, { query: "Ada" });

    expect(result).not.toBeNull();
    expect(result.id).toBe("entity-UBBB222");
  });
});

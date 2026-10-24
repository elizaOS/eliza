/**
 * A Discord connection edit (new agent or new bot token) releases the
 * connection, and the same pod often claims it again in its next poll. Runs
 * the real GatewayManager poll against a scripted assignments endpoint; only
 * the discord.js Client is replaced so no Discord login happens.
 */
import { beforeEach, expect, mock, test } from "bun:test";

process.env.MOCK_REDIS = "1";

const logins: string[] = [];
const destroyed: string[] = [];

class FakeClient {
  token: string | null = null;
  user = { id: "bot-user", username: "bot" };
  guilds = { cache: { size: 0 } };
  on() {
    return this;
  }
  once() {
    return this;
  }
  removeAllListeners() {
    return this;
  }
  async login(token: string) {
    this.token = token;
    logins.push(token);
    return token;
  }
  destroy() {
    destroyed.push(this.token ?? "");
  }
}

const realDiscord = await import("discord.js");
mock.module("discord.js", () => ({ ...realDiscord, Client: FakeClient }));

const { GatewayManager } = await import("../src/gateway-manager");

type Assignment = {
  connectionId: string;
  organizationId: string;
  applicationId: string;
  botToken: string;
  intents: number;
  characterId: string | null;
};

let assignments: Assignment[] = [];
const manager = new GatewayManager(
  {
    podName: "gateway-pod-1",
    elizaCloudUrl: "http://127.0.0.1:9",
    gatewayBootstrapSecret: "bootstrap",
    project: "test",
  },
  {
    fetchAssignments: (async () => Response.json({ assignments })) as never,
  },
);
const internal = manager as unknown as {
  pollForBots(): Promise<void>;
  connections: Map<string, { characterId: string | null }>;
  accessToken: string | null;
  tokenExpiresAt: Date | null;
};
// The control-plane token that start() would acquire.
internal.accessToken = "gateway-access-token";
internal.tokenExpiresAt = new Date(Date.now() + 3_600_000);

function assignment(botToken: string, characterId: string): Assignment {
  return {
    connectionId: "conn-1",
    organizationId: "org-1",
    applicationId: "app-1",
    botToken,
    intents: 0,
    characterId,
  };
}

beforeEach(() => {
  logins.length = 0;
  destroyed.length = 0;
});

test("a new agent for a connection takes effect on the running bot", async () => {
  assignments = [assignment("token-a", "agent-a")];
  await internal.pollForBots();
  assignments = [assignment("token-a", "agent-b")];
  await internal.pollForBots();

  expect(logins).toEqual(["token-a"]);
  expect(internal.connections.get("conn-1")?.characterId).toBe("agent-b");
});

test("a new bot token replaces the running Discord client", async () => {
  assignments = [assignment("token-a", "agent-b")];
  await internal.pollForBots();
  assignments = [assignment("token-b", "agent-b")];
  await internal.pollForBots();

  expect(destroyed).toEqual(["token-a"]);
  expect(logins).toEqual(["token-b"]);
  expect(internal.connections.size).toBe(1);
});

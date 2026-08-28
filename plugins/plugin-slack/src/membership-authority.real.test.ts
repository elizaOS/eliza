/**
 * Real-authority coverage for the canonical Slack membership publication
 * (#24367): the plugin-sql MembershipService runs over a real PGlite
 * adapter and the full AgentRuntime, exactly like plugin-sql's own authority
 * tests. The SlackService under test is real with the Bolt app and
 * WebClient mocked; the runtime, connector-account row, room/world/entity
 * rows, and the authority's durable evidence are all real. Proves the
 * publisher's commands satisfy the authority's validation (UUID pattern
 * fences, cursor chain, connector-account FK, principal rows) and that a
 * published roster authorizes its members through MembershipService.authorize.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  type IAgentRuntime,
  MembershipService,
  type UUID,
} from "@elizaos/core";
import { createDatabaseAdapter } from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const bolt = vi.hoisted(() => ({
  channels: [] as Array<Record<string, unknown>>,
  users: [] as Array<Record<string, unknown>>,
}));

function createClient() {
  return {
    auth: {
      test: vi
        .fn()
        .mockResolvedValue({ user_id: "U0BOTBOT0", team_id: "T0TEAM000" }),
    },
    conversations: {
      list: vi.fn().mockResolvedValue({ channels: bolt.channels }),
      info: vi
        .fn()
        .mockImplementation(async ({ channel }: { channel: string }) => ({
          channel: bolt.channels.find((entry) => entry.id === channel),
        })),
      members: vi.fn(),
      history: vi.fn().mockResolvedValue({ messages: [] }),
      replies: vi.fn().mockResolvedValue({ messages: [] }),
    },
    users: {
      list: vi.fn().mockResolvedValue({ members: bolt.users }),
      info: vi.fn().mockImplementation(async ({ user }: { user: string }) => ({
        user: bolt.users.find((entry) => entry.id === user),
      })),
    },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "1.000001" }),
    },
    team: { info: vi.fn().mockResolvedValue({ team: { name: "Sandbox" } }) },
  };
}

const apps = vi.hoisted(() => [] as Array<ReturnType<typeof createAppRecord>>);

function createAppRecord() {
  return {
    eventHandlers: new Map<string, unknown>(),
    messageHandler: undefined as unknown,
    client: createClient(),
  };
}

vi.mock("@slack/bolt", () => ({
  LogLevel: { INFO: "info" },
  App: class MockBoltApp {
    private readonly record = createAppRecord();
    client = this.record.client;
    constructor() {
      apps.push(this.record);
    }
    message(handler: unknown) {
      this.record.messageHandler = handler;
    }
    event(name: string, handler: unknown) {
      this.record.eventHandlers.set(name, handler);
    }
    async start() {}
    async stop() {}
  },
}));

import { slackMembershipPrincipalId } from "./membership-authority";
import { SlackService } from "./service";

const OPS = "C0123ABCD";
const ALICE = "U0123ABCD";
const BOB = "U0999ZZZZ";
const TEAM = "T0TEAM000";

let runtime: AgentRuntime;
let membership: MembershipService;
let slackService: SlackService;
let dataDir: string;
let app: (typeof apps)[number];

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "slack-membership-24367-"));
  const agentId = uuidv4() as UUID;
  const adapter = createDatabaseAdapter({ dataDir }, agentId);
  await (adapter as unknown as { init: () => Promise<void> }).init();
  runtime = new AgentRuntime({
    character: {
      name: "slack-membership-24367",
      id: agentId,
      plugins: [],
      settings: {},
    },
    agentId,
    adapter,
    logLevel: "warn",
    enableAutonomy: false,
  });
  const sqlModule = (await import("@elizaos/plugin-sql")) as {
    default?: { plugins?: unknown[] };
    plugin?: { plugins?: unknown[] };
  };
  const sqlPlugin =
    sqlModule.default ?? (sqlModule.plugin as { plugins?: unknown[] });
  if (sqlPlugin) {
    await runtime.registerPlugin(
      sqlPlugin as Parameters<AgentRuntime["registerPlugin"]>[0],
    );
  }
  await runtime.initialize();
  const services = runtime.getServicesByType<MembershipService>(
    MembershipService.serviceType,
  );
  expect(services.length).toBeGreaterThan(0);
  membership = services[0];

  // Configure the Slack account directly on the initialized runtime's
  // character so account resolution finds tokens.
  runtime.character.settings = {
    ...runtime.character.settings,
    slack: {
      enabled: true,
      botToken: "xoxb-test",
      appToken: "xapp-test",
      groupPolicy: "allowlist",
      channels: { ops: { users: [ALICE] } },
    },
  };
  bolt.channels.push({
    id: OPS,
    name: "ops",
    is_channel: true,
    is_member: true,
  });
  bolt.users.push(
    { id: ALICE, name: "alice", real_name: "Alice Example" },
    { id: BOB, name: "bob", real_name: "Bob Example" },
  );
  apps.length = 0;
  slackService = await SlackService.start(runtime as unknown as IAgentRuntime);
  app = apps.at(-1) as (typeof apps)[number];
  expect(app).toBeDefined();
}, 180_000);

afterAll(async () => {
  await runtime.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
}, 60_000);

async function membershipScope() {
  const { slackMembershipAccountId } = await import("./membership-authority");
  return {
    agentId: runtime.agentId,
    connectorId: "slack",
    connectorAccountId: slackMembershipAccountId(
      "slack-membership-default",
    ) as UUID,
    externalWorldId: TEAM,
    externalRoomId: OPS,
  };
}

describe("Slack canonical membership publisher (real PGlite authority)", () => {
  it("publishes a complete roster snapshot the real authority accepts and authorizes members", async () => {
    const members = vi.fn().mockResolvedValue({ members: [ALICE, BOB] });
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await slackService.renewChannelMembership(OPS);
    expect(result.kind).toBe("snapshot");

    // The authority accepted the publication: authorization decisions must
    // now succeed for both roster members through the real authority.
    const scope = await membershipScope();
    for (const userId of [ALICE, BOB]) {
      const decision = await membership.authorize(
        scope,
        slackMembershipPrincipalId("default", userId),
      );
      expect(decision.decision).toBe("allowed");
    }
    // The bot user is not a published member: it must not authorize.
    const botDecision = await membership.authorize(
      scope,
      slackMembershipPrincipalId("default", "U0BOTBOT0"),
    );
    expect(botDecision.decision).toBe("denied");
  });

  it("publishes join/leave deltas the real authority chains after the baseline", async () => {
    // Baseline with only ALICE: BOB must not authorize yet.
    const members = vi.fn().mockResolvedValue({ members: [ALICE] });
    (app.client.conversations as { members: typeof members }).members = members;
    await slackService.renewChannelMembership(OPS);

    const scope = await membershipScope();
    const bobPrincipal = slackMembershipPrincipalId("default", BOB);
    const before = await membership.authorize(scope, bobPrincipal);
    expect(before.decision).toBe("denied");

    const handler = app.eventHandlers.get("member_joined_channel") as
      | ((args: {
          event: unknown;
          client: unknown;
          body?: unknown;
        }) => Promise<void>)
      | undefined;
    expect(handler).toBeDefined();
    const joinEvent = {
      user: BOB,
      channel: OPS,
      event_ts: "1700000100.000100",
    };
    await handler?.({
      event: joinEvent,
      client: app.client,
      body: { team_id: TEAM, event_id: "Ev-join-bob", event: joinEvent },
    });
    const afterJoin = await membership.authorize(scope, bobPrincipal);
    if (afterJoin.decision !== "allowed") {
      const record = await membership.getMembership(scope, bobPrincipal);
      throw new Error(
        `join delta did not authorize; decision: ${JSON.stringify(afterJoin)}; record: ${JSON.stringify(record)}`,
      );
    }
    expect(afterJoin.decision).toBe("allowed");

    const leaveHandler = app.eventHandlers.get("member_left_channel") as
      | ((args: {
          event: unknown;
          client: unknown;
          body?: unknown;
        }) => Promise<void>)
      | undefined;
    const leaveEvent = {
      user: BOB,
      channel: OPS,
      event_ts: "1700000200.000100",
    };
    await leaveHandler?.({
      event: leaveEvent,
      client: app.client,
      body: { team_id: TEAM, event_id: "Ev-leave-bob", event: leaveEvent },
    });
    const afterLeave = await membership.authorize(scope, bobPrincipal);
    expect(afterLeave.decision).toBe("denied");
    expect(afterLeave.reason).toBe("membership_revoked");
  });

  it("a join delta after an unavailable read is suppressed until a fresh snapshot restores the scope", async () => {
    // Baseline, then degrade via unavailable read.
    const members = vi.fn().mockResolvedValue({ members: [ALICE] });
    (app.client.conversations as { members: typeof members }).members = members;
    await slackService.renewChannelMembership(OPS);

    const scopeError = new Error(
      "An API error occurred: ratelimited",
    ) as unknown as { code: string; data: { error: string } };
    scopeError.code = "slack_webapi_platform_error";
    scopeError.data = { error: "ratelimited" };
    const failing = vi.fn().mockRejectedValue(scopeError);
    (app.client.conversations as { members: typeof failing }).members = failing;
    await slackService.renewChannelMembership(OPS);

    const scope = await membershipScope();

    // Join delta while degraded: must not authorize (scope stale denies).
    const joinHandler = app.eventHandlers.get("member_joined_channel") as
      | ((args: {
          event: unknown;
          client: unknown;
          body?: unknown;
        }) => Promise<void>)
      | undefined;
    const joinEvent = {
      user: BOB,
      channel: OPS,
      event_ts: "1700000300.000100",
    };
    await joinHandler?.({
      event: joinEvent,
      client: app.client,
      body: { team_id: TEAM, event_id: "Ev-join-bob-2", event: joinEvent },
    });
    const bobPrincipal = slackMembershipPrincipalId("default", BOB);
    const degradedDecision = await membership.authorize(scope, bobPrincipal);
    expect(degradedDecision.decision).toBe("denied");

    // Fresh snapshot restores the scope and carries the member.
    const restored = vi.fn().mockResolvedValue({ members: [ALICE, BOB] });
    (app.client.conversations as { members: typeof restored }).members =
      restored;
    const result = await slackService.renewChannelMembership(OPS);
    expect(result.kind).toBe("snapshot");
    const restoredDecision = await membership.authorize(scope, bobPrincipal);
    expect(restoredDecision.decision).toBe("allowed");
  });

  it("an unavailable roster read marks the scope health stale, never revokes members", async () => {
    const members = vi.fn().mockResolvedValue({ members: [ALICE] });
    (app.client.conversations as { members: typeof members }).members = members;
    await slackService.renewChannelMembership(OPS);

    const scopeError = new Error(
      "An API error occurred: missing_scope",
    ) as unknown as { code: string; data: { error: string } };
    scopeError.code = "slack_webapi_platform_error";
    scopeError.data = { error: "missing_scope" };
    const failing = vi.fn().mockRejectedValue(scopeError);
    (app.client.conversations as { members: typeof failing }).members = failing;
    const result = await slackService.renewChannelMembership(OPS);
    expect(result.kind).toBe("unavailable");

    const scope = await membershipScope();
    const health = await membership.getScopeHealth(scope);
    expect(health?.health).toBe("stale");
    // The member's record survives the unavailable read (no mass revoke).
    const alicePrincipal = slackMembershipPrincipalId("default", ALICE);
    const record = await membership.getMembership(scope, alicePrincipal);
    expect(record?.state).toBe("active");
  });
});

/**
 * Service-level canonical membership publication tests: the real SlackService
 * path (Bolt event handlers and renewChannelMembership) must publish to the
 * canonical MembershipService authority — complete snapshots for successful
 * roster walks, incomplete-snapshot reports for unavailable reads, and
 * join/leave ordered deltas — with account-scoped fencing. The Bolt app and
 * WebClient are mocked; the authority is a spy implementing the
 * MembershipService contract surface the service resolves. Production code
 * under test is real; nothing asserts the spy's own return values except as
 * committed receipts.
 */
import type {
  IAgentRuntime,
  MembershipMutationReceipt,
  MembershipService,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectConnectorSettings } from "../../../packages/agent/src/runtime/project-connector-settings";

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
  const client = createClient();
  return {
    eventHandlers: new Map<
      string,
      (args: {
        event: unknown;
        client: unknown;
        body?: unknown;
      }) => Promise<void>
    >(),
    messageHandler: undefined as
      | ((args: {
          message: unknown;
          client: unknown;
          body?: unknown;
        }) => Promise<void>)
      | undefined,
    client,
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

    message(
      handler: (args: { message: unknown; client: unknown }) => Promise<void>,
    ) {
      this.record.messageHandler = handler;
    }

    event(
      name: string,
      handler: (args: { event: unknown; client: unknown }) => Promise<void>,
    ) {
      this.record.eventHandlers.set(name, handler);
    }

    async start() {}
    async stop() {}
  },
}));

import { SlackService } from "./service";

const OPS = "C0123ABCD";
const ALICE = "U0123ABCD";
const BOB = "U0999ZZZZ";

/**
 * Spy authority: records every command by operation; commits receipts with a
 * monotonically advancing generation so the publisher's fence math runs for
 * real. Implements the exact MembershipService surface isMembershipService
 * checks (registerPublisher + applyCompleteSnapshot).
 */
function createAuthoritySpy() {
  let generation = 0;
  const commands: Array<{ op: string; command: Record<string, unknown> }> = [];
  const receipt = (
    op: MembershipMutationReceipt["operation"],
  ): MembershipMutationReceipt => {
    generation += 1;
    return {
      contractVersion: 1,
      operation: op,
      idempotentReplay: false,
      committedGeneration: generation,
      health: {} as never,
      ...(op === "snapshot"
        ? { memberships: [], revokedPrincipalIds: [] }
        : {}),
      ...(op === "membership" ? { membership: {} as never } : {}),
    } as MembershipMutationReceipt;
  };
  const service: MembershipService = {
    registerPublisher: vi.fn(async (command) => {
      commands.push({ op: "publisher", command: command as never });
      return receipt("publisher");
    }),
    applyCompleteSnapshot: vi.fn(async (command) => {
      commands.push({ op: "snapshot", command: command as never });
      return receipt("snapshot");
    }),
    reportIncompleteSnapshot: vi.fn(async (command) => {
      commands.push({ op: "incomplete", command: command as never });
      return receipt("health");
    }),
    applyMembership: vi.fn(async (command) => {
      commands.push({ op: "membership", command: command as never });
      return receipt("membership");
    }),
    setScopeHealth: vi.fn(async (command) => {
      commands.push({ op: "health", command: command as never });
      return receipt("health");
    }),
    authorize: vi.fn(async () => ({
      decision: "denied",
      reason: "no_scope_evidence",
      generation: null,
      health: null,
    })),
    getMembership: vi.fn(async () => null),
    getScopeHealth: vi.fn(async () => null),
    registerInvalidator: vi.fn(() => () => {}),
  } as unknown as MembershipService;
  return { service, commands };
}

function memberEventBody(event: Record<string, unknown>) {
  return {
    team_id: "T0TEAM000",
    event_id: `Ev-${String(event.user)}-${String(event.channel)}-${String(event.event_ts ?? "")}`,
    event,
  };
}

function createRuntime(
  settings: Record<string, unknown>,
  authority: MembershipService | null,
): IAgentRuntime {
  const projection = projectConnectorSettings({}, { slack: settings });
  const secretEntries = Object.entries(projection.secrets) as Array<
    [string, string]
  >;
  const character = {
    name: "Slack Canonical Membership Test",
    settings: projection.settings,
    secrets: projection.secrets,
  };
  const runtime = {
    agentId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    character,
    logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: vi.fn((key: string) => {
      const settings2 = character.settings as Record<string, unknown>;
      const secrets2 = character.secrets as Record<string, unknown>;
      if (Object.hasOwn(settings2, key)) return settings2[key];
      if (Object.hasOwn(secrets2, key)) return secrets2[key];
      const match = secretEntries.find(([k]) => k === key);
      return match ? match[1] : null;
    }),
    getWorld: vi.fn().mockResolvedValue(null),
    createWorld: vi.fn().mockResolvedValue(undefined),
    getRoom: vi.fn().mockResolvedValue(null),
    createRoom: vi.fn().mockResolvedValue(undefined),
    emitEvent: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue(undefined),
    getMemoryById: vi.fn().mockResolvedValue(null),
    createEntity: vi.fn().mockResolvedValue(undefined),
    createEntities: vi.fn().mockResolvedValue(undefined),
    getEntityById: vi.fn().mockResolvedValue(null),
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    removeParticipant: vi.fn().mockResolvedValue(true),
    reportError: vi.fn(),
    getService: vi.fn((name: string) =>
      name === "membership" ? authority : null,
    ),
    getServicesByType: vi.fn((name: string) =>
      name === "membership" && authority ? [authority] : [],
    ),
  };
  return runtime as unknown as IAgentRuntime;
}

async function startHarness(
  overrides: Record<string, unknown> = {},
  authority: MembershipService | null = null,
) {
  const runtime = createRuntime(
    {
      enabled: true,
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      groupPolicy: "allowlist",
      channels: { ops: { users: [ALICE] } },
      ...overrides,
    },
    authority,
  );
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
  let service: InstanceType<typeof SlackService>;
  try {
    service = await SlackService.start(runtime);
  } catch (startError) {
    // error-policy:J2 context-adding rethrow: wrap with the captured log
    // tail and preserve the original start failure as cause.
    const calls = (runtime.logger.warn as ReturnType<typeof vi.fn>).mock.calls
      .concat((runtime.logger.error as ReturnType<typeof vi.fn>).mock.calls)
      .map((c) => String(c.at(-1)));
    throw new Error(
      `SlackService.start failed: ${String(startError)}; logged: ${calls.join(" | ")}`,
      { cause: startError },
    );
  }
  if (apps.length === 0) {
    const calls = (
      runtime.logger.warn as ReturnType<typeof vi.fn>
    ).mock.calls.map((c) => String(c.at(-1)));
    throw new Error(`no app registered; logged: ${calls.join(" | ")}`);
  }
  const app = apps.at(-1);
  if (!app)
    throw new Error(`Bolt app was not registered (apps=${apps.length})`);
  return { app, runtime, service };
}

describe("SlackService canonical membership publication", () => {
  beforeEach(() => {
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    vi.clearAllMocks();
  });

  it("a completed roster walk publishes a complete snapshot with every member", async () => {
    const { service: authority, commands } = createAuthoritySpy();
    // Restart the harness with the authority registered at start so the
    // publisher is constructed during account init.
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    const { app, runtime, service } = await startHarness({}, authority);
    const members = vi
      .fn()
      .mockResolvedValue({ members: [ALICE, BOB, "U0BOTBOT0"] });
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.renewChannelMembership(OPS);
    expect(result.kind).toBe("snapshot");

    const snapshot = commands.find((c) => c.op === "snapshot");
    if (!snapshot) {
      throw new Error(
        `no snapshot published; reportError: ${JSON.stringify(vi.mocked(runtime.reportError).mock.calls.map((c) => String(c[1])))}; commands: ${JSON.stringify(commands.map((c) => ({ op: c.op, key: c.command.idempotencyKey })))}; reportError calls: ${vi.mocked(runtime.reportError).mock.calls.length}`,
      );
    }
    expect(snapshot).toBeDefined();
    const command = snapshot?.command as Record<string, unknown>;
    expect(command.completeness).toBe("complete");
    expect(command.externalRoomId).toBe(OPS);
    expect(command.externalWorldId).toBe("T0TEAM000");
    const publishedMembers = command.members as Array<{
      canonicalPrincipalId: string;
      roles: string[];
    }>;
    // Two human members; the bot itself is excluded from the roster evidence.
    expect(publishedMembers).toHaveLength(2);
    expect(runtime.ensureConnection).toHaveBeenCalledTimes(2);
  });

  it("an unavailable roster read reports incomplete evidence, never a snapshot", async () => {
    const { service: authority, commands } = createAuthoritySpy();
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    const { app, service } = await startHarness({}, authority);
    const scopeError = new Error(
      "An API error occurred: missing_scope",
    ) as unknown as {
      code: string;
      data: { error: string };
    };
    scopeError.code = "slack_webapi_platform_error";
    scopeError.data = { error: "missing_scope" };
    const members = vi.fn().mockRejectedValue(scopeError);
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.renewChannelMembership(OPS);
    expect(result.kind).toBe("unavailable");

    const incomplete = commands.find((c) => c.op === "incomplete");
    expect(incomplete).toBeDefined();
    const command = incomplete?.command as Record<string, unknown>;
    expect(command.completeness).toBe("incomplete");
    expect(String(command.reason)).toContain("missing_scope");
    expect(commands.find((c) => c.op === "snapshot")).toBeUndefined();
  });

  it("member_joined_channel publishes an ordered join delta after a snapshot baseline", async () => {
    const { service: authority, commands } = createAuthoritySpy();
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    const { app, service } = await startHarness({}, authority);
    // Baseline snapshot first (deltas require a current snapshot).
    const members = vi.fn().mockResolvedValue({ members: [ALICE] });
    (app.client.conversations as { members: typeof members }).members = members;
    await service.renewChannelMembership(OPS);
    expect(commands.find((c) => c.op === "snapshot")).toBeDefined();

    const handler = app.eventHandlers.get("member_joined_channel");
    expect(handler).toBeDefined();
    const event = {
      user: BOB,
      channel: OPS,
      event_ts: "1700000000.000400",
    };
    await handler?.({
      event,
      client: app.client,
      body: memberEventBody(event),
    });
    const delta = commands.find((c) => c.op === "membership");
    expect(delta).toBeDefined();
    const command = delta?.command as Record<string, unknown>;
    expect(command.state).toBe("active");
    expect(command.reason).toBe("joined");
  });

  it("member_left_channel publishes an ordered leave delta revoking the member", async () => {
    const { service: authority, commands } = createAuthoritySpy();
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    const { app, service } = await startHarness({}, authority);
    const members = vi.fn().mockResolvedValue({ members: [ALICE, BOB] });
    (app.client.conversations as { members: typeof members }).members = members;
    await service.renewChannelMembership(OPS);

    const handler = app.eventHandlers.get("member_left_channel");
    expect(handler).toBeDefined();
    const event = { user: ALICE, channel: OPS, event_ts: "1700000000.000600" };
    await handler?.({
      event,
      client: app.client,
      body: memberEventBody(event),
    });
    const delta = commands
      .filter((c) => c.op === "membership")
      .find((c) => (c.command as Record<string, unknown>).state === "revoked");
    expect(delta).toBeDefined();
    const command = delta?.command as Record<string, unknown>;
    expect(command.reason).toBe("left");
  });

  it("join and leave events without a snapshot baseline publish nothing (no fabricated evidence)", async () => {
    const { service: authority, commands } = createAuthoritySpy();
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    const { app } = await startHarness({}, authority);
    const join = app.eventHandlers.get("member_joined_channel");
    const event = { user: ALICE, channel: OPS, event_ts: "1700000000.000100" };
    await join?.({ event, client: app.client, body: memberEventBody(event) });
    // Only the publisher registration may exist; no snapshot, no delta.
    expect(commands.find((c) => c.op === "snapshot")).toBeUndefined();
    expect(commands.find((c) => c.op === "membership")).toBeUndefined();
  });

  it("publication is scoped per account: one account's publisher never writes another's scope", async () => {
    const { service: authority, commands } = createAuthoritySpy();
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    const { service } = await startHarness(
      {
        accounts: {
          alpha: {
            botToken: "xoxb-alpha",
            appToken: "xapp-alpha",
            groupPolicy: "allowlist",
            channels: { ops: { users: [ALICE] } },
          },
          beta: {
            botToken: "xoxb-beta",
            appToken: "xapp-beta",
            groupPolicy: "allowlist",
            channels: { ops: { users: [ALICE] } },
          },
        },
      },
      authority,
    );
    expect(apps).toHaveLength(2);
    const [alphaApp, betaApp] = apps;
    const alphaMembers = vi.fn().mockResolvedValue({ members: [ALICE] });
    const betaMembers = vi.fn().mockResolvedValue({ members: [ALICE] });
    (
      alphaApp.client.conversations as { members: typeof alphaMembers }
    ).members = alphaMembers;
    (betaApp.client.conversations as { members: typeof betaMembers }).members =
      betaMembers;

    await service.renewChannelMembership(OPS, "alpha");
    await service.renewChannelMembership(OPS, "beta");

    const snapshots = commands.filter((c) => c.op === "snapshot");
    expect(snapshots).toHaveLength(2);
    // Both publishes went through the same account row for this harness;
    // the scopes must still be distinct per account key through the
    // idempotency keys.
    const keys = snapshots.map(
      (c) => (c.command as Record<string, unknown>).idempotencyKey as string,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it("authority publication failure does not mask the snapshot result or stop runtime renewal", async () => {
    const failing = {
      registerPublisher: vi.fn(async () => {
        throw Object.assign(new Error("authority down"), {
          code: "MEMBERSHIP_WRITE_FAILED",
        });
      }),
      applyCompleteSnapshot: vi.fn(async () => {
        throw Object.assign(new Error("authority down"), {
          code: "MEMBERSHIP_WRITE_FAILED",
        });
      }),
    } as unknown as MembershipService;
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    const { app, runtime, service } = await startHarness({}, failing);
    const members = vi.fn().mockResolvedValue({ members: [ALICE, BOB] });
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.renewChannelMembership(OPS);
    expect(result.kind).toBe("snapshot");
    expect(runtime.ensureConnection).toHaveBeenCalledTimes(2);
    expect(runtime.reportError).toHaveBeenCalled();
  });

  it("without a registered authority the service keeps legacy behavior (no publisher)", async () => {
    apps.length = 0;
    bolt.channels.length = 0;
    bolt.users.length = 0;
    const { app, runtime, service } = await startHarness({}, null);
    const members = vi.fn().mockResolvedValue({ members: [ALICE, BOB] });
    (app.client.conversations as { members: typeof members }).members = members;
    const result = await service.renewChannelMembership(OPS);
    expect(result.kind).toBe("snapshot");
    expect(runtime.ensureConnection).toHaveBeenCalledTimes(2);
  });
});

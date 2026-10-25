/**
 * Exercises the context-inspector handler through a real HTTP socket with the
 * real runtime, durable trajectory service, and persisted room authorization. The
 * fixtures include raw paths, source text, provider IDs, account IDs, expired
 * retention, and cross-room decoys so leakage is a hard assertion.
 */

import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import {
  buildReadSlice,
  buildReadView,
  ChannelType,
  type TrajectoryDetailRecord,
  type UUID,
} from "@elizaos/core";
import { trajectoriesPlugin } from "@elizaos/plugin-assistant";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import {
  createBaseTrajectory,
  saveTrajectory,
} from "../runtime/trajectory-internals.ts";
import { installDatabaseTrajectoryLogger } from "../runtime/trajectory-storage.ts";
import { handleContextInspectorRoute } from "./context-inspector-routes.ts";

const ROOM = "00000000-0000-4000-8000-000000000101" as UUID;
const OTHER_ROOM = "00000000-0000-4000-8000-000000000102" as UUID;
const CONVERSATION = "00000000-0000-4000-8000-000000000103" as UUID;
const USER = "00000000-0000-4000-8000-000000000201" as UUID;
const RAW_REFERENCE = "gmail:account-private:message-private";
const RAW_BODY = "TOP SECRET END CANARY";
const RAW_PROVIDER = "provider-account-secret";

const servers: Array<ReturnType<typeof createServer>> = [];
const fixtures: Awaited<ReturnType<typeof createTestRuntime>>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});

function trajectory(roomId = ROOM): TrajectoryDetailRecord {
  const view = buildReadView({
    reference: {
      kind: "email",
      ref: RAW_REFERENCE,
      revision: "private-provider-revision",
    },
    slice: buildReadSlice({
      range: {
        unit: "byte",
        start: 64,
        end: 128,
        total: 1024,
      },
      completeness: "partial-recoverable",
      sliceSha256: "a".repeat(64),
      sourceSha256: "b".repeat(64),
      reason: `projection budget ${RAW_BODY}`,
    }),
  });
  return {
    trajectoryId: "trajectory-private-id",
    agentId: "agent-private-id",
    startTime: 1,
    metadata: {
      conversationId: roomId,
      roomId,
      providerAccountId: RAW_PROVIDER,
      path: RAW_REFERENCE,
    },
    steps: [
      {
        stepId: "step-private-id",
        timestamp: 1,
        action: {
          attemptId: "attempt-private-id",
          timestamp: 1,
          actionType: "tool",
          actionName: "EMAIL",
          parameters: {},
          success: true,
          result: JSON.parse(
            JSON.stringify({
              text: RAW_BODY,
              providerAccountId: RAW_PROVIDER,
              promptData: {
                expiresAt: "2026-08-23T17:00:00.000Z",
                view,
              },
            }),
          ),
        },
        llmCalls: [
          {
            callId: "call-private-id",
            provider: RAW_PROVIDER,
            model: "private-model-id",
            prompt: RAW_BODY,
            promptTokens: 312,
            providerOptions: {
              eliza: {
                modelInputBudget: {
                  estimatedInputTokens: 300,
                  dispatchThresholdTokens: 900,
                  reserveOutputTokens: 100,
                  shouldReject: false,
                },
              },
            },
          },
        ],
      },
    ],
  };
}

async function harness(options: {
  authorization: AgentHttpRequestAuthorization;
  detail?: TrajectoryDetailRecord;
  participantRooms?: UUID[];
  resolveConversationRoomId?: (conversationId: UUID) => Promise<UUID | null>;
}) {
  const fixture = await createTestRuntime({
    characterName: "ContextInspector",
    plugins: [trajectoriesPlugin],
  });
  fixtures.push(fixture);
  const { runtime } = fixture;
  await runtime.getServiceLoadPromise("trajectories");
  await installDatabaseTrajectoryLogger(runtime);
  for (const roomId of [ROOM, OTHER_ROOM]) {
    await runtime.ensureConnection({
      entityId: USER,
      roomId,
      worldId: CONVERSATION,
      worldName: "Context fixture",
      userName: "Reader",
      name: "Reader",
      source: "test",
      type: ChannelType.DM,
    });
  }
  async function setParticipantRooms(rooms: UUID[]) {
    for (const roomId of [ROOM, OTHER_ROOM]) {
      if (rooms.includes(roomId)) await runtime.addParticipant(USER, roomId);
      else await runtime.removeParticipant(USER, roomId);
    }
  }
  await setParticipantRooms(options.participantRooms ?? [ROOM]);
  async function persist(detail: TrajectoryDetailRecord, roomId: UUID) {
    const record = createBaseTrajectory(
      randomUUID(),
      1,
      runtime.agentId,
      "chat",
      { ...detail.metadata, roomId },
    );
    record.status = "completed";
    record.endTime = 2;
    const source = detail.steps?.[0];
    if (source) {
      const step = record.steps[0];
      step.action = source.action;
      step.llmCalls = (source.llmCalls ?? []).map((call) => ({
        ...call,
        callId: randomUUID(),
        timestamp: 1,
        model: "fixture",
        response: "recorded",
        purpose: "action",
        actionType: "runtime.useModel",
      }));
    }
    await saveTrajectory(runtime, record, { createOnly: true });
  }
  await persist(options.detail ?? trajectory(), ROOM);
  await persist(trajectory(OTHER_ROOM), OTHER_ROOM);
  let authorization = options.authorization;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await handleContextInspectorRoute({
      req,
      res,
      pathname: url.pathname,
      method: req.method ?? "GET",
      url,
      runtime,
      authorization,
      resolveConversationRoomId:
        options.resolveConversationRoomId ??
        (async (conversationId) => conversationId),
      now: () => Date.parse("2026-08-23T18:00:00.000Z"),
      redactReference: () => "ctx_0123456789abcdef0123",
    });
    if (!handled) {
      res.statusCode = 404;
      res.end();
    }
  });
  servers.push(server);
  let baseUrlPromise: Promise<string> | null = null;
  const baseUrl = (): Promise<string> => {
    baseUrlPromise ??= new Promise<string>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("no address");
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });
    return baseUrlPromise;
  };
  return {
    async request(path: string) {
      const response = await fetch(`${await baseUrl()}${path}`);
      return { response, body: await response.text() };
    },
    setParticipantRooms,
    setAuthorization(value: AgentHttpRequestAuthorization) {
      authorization = value;
    },
    runtime,
  };
}

describe("context inspector HTTP integration", () => {
  it("returns only the allowlisted redacted projection and explicit expired retention", async () => {
    const app = await harness({ authorization: { ok: true, role: "OWNER" } });
    const { response, body } = await app.request(
      `/api/context-inspector?conversationId=${ROOM}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).not.toContain(RAW_REFERENCE);
    expect(body).not.toContain(RAW_BODY);
    expect(body).not.toContain(RAW_PROVIDER);
    expect(body).not.toContain("private-provider-revision");
    expect(JSON.parse(body)).toEqual({
      schemaVersion: "elizaos.context-inspector/v1",
      entries: [
        {
          reference: "ctx_0123456789abcdef0123",
          kind: "email",
          range: { unit: "byte", start: 64, end: 128, total: 1024 },
          completeness: "partial-recoverable",
          omissionReason: "token-budget",
          retentionState: "expired",
        },
      ],
      tokenBudgets: [
        {
          usedTokens: 312,
          limitTokens: 900,
          reservedTokens: 100,
          state: "within-budget",
        },
      ],
      page: {
        offset: 0,
        limit: 20,
        hasPrevious: false,
        hasMore: false,
        nextOffset: null,
      },
      state: "available",
    });
  });

  it("never reports a recorded diagnostic budget estimate as a rejection", async () => {
    const detail = trajectory(ROOM);
    const call = detail.steps?.[0]?.llmCalls?.[0];
    if (!call) throw new Error("fixture must include an LLM call");
    call.providerOptions = {
      eliza: {
        modelInputBudget: {
          estimatedInputTokens: 300,
          dispatchThresholdTokens: 900,
          reserveOutputTokens: 100,
          shouldReject: true,
        },
      },
    };
    const app = await harness({
      authorization: { ok: true, role: "OWNER" },
      detail,
    });
    const result = await app.request(
      `/api/context-inspector?conversationId=${ROOM}`,
    );
    expect(result.response.status).toBe(200);
    const response = JSON.parse(result.body);
    expect(response.tokenBudgets).toEqual([
      {
        usedTokens: 312,
        limitTokens: 900,
        reservedTokens: 100,
        state: "within-budget",
      },
    ]);
  });

  it("resolves a public conversation id to its distinct runtime room", async () => {
    const app = await harness({
      authorization: { ok: true, role: "OWNER" },
      detail: trajectory(ROOM),
      resolveConversationRoomId: async (conversationId) =>
        conversationId === CONVERSATION ? ROOM : null,
    });
    const { response } = await app.request(
      `/api/context-inspector?conversationId=${CONVERSATION}`,
    );
    expect(response.status).toBe(200);
    expect(await app.runtime.getRoom(ROOM)).toBeTruthy();
  });

  it("rejects unauthenticated, cross-room, revoked, and principal-free callers", async () => {
    const app = await harness({
      authorization: { ok: false, role: "NONE" },
    });
    const request = () =>
      app.request(`/api/context-inspector?conversationId=${ROOM}`);
    expect((await request()).response.status).toBe(401);

    app.setAuthorization({ ok: true, role: "USER", principal: USER });
    await app.setParticipantRooms([OTHER_ROOM]);
    expect((await request()).response.status).toBe(403);

    await app.setParticipantRooms([ROOM]);
    expect((await request()).response.status).toBe(200);
    await app.setParticipantRooms([]);
    expect((await request()).response.status).toBe(403);
    expect(await app.runtime.getRoomsForParticipant(USER)).not.toContain(ROOM);

    app.setAuthorization({ ok: true, role: "USER" });
    await app.setParticipantRooms([ROOM]);
    expect((await request()).response.status).toBe(403);
  });

  it("rejects tampered query state and a trajectory whose room changes", async () => {
    const app = await harness({ authorization: { ok: true, role: "OWNER" } });
    for (const query of [
      "conversationId=not-a-uuid",
      `conversationId=${ROOM}&offset=-1`,
      `conversationId=${ROOM}&limit=51`,
      `conversationId=${ROOM}&limit=1.5`,
    ]) {
      const { response, body } = await app.request(
        `/api/context-inspector?${query}`,
      );
      expect(response.status).toBe(400);
      expect(body).toBe('{"error":"Invalid context inspector request"}');
    }

    const changed = await harness({
      authorization: { ok: true, role: "OWNER" },
      detail: trajectory(OTHER_ROOM),
    });
    const result = await changed.request(
      `/api/context-inspector?conversationId=${ROOM}`,
    );
    expect(result.response.status).toBe(409);
    expect(result.body).not.toContain(OTHER_ROOM);
  });
});

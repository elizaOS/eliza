/**
 * Exercises the context-inspector handler through a real HTTP socket with an
 * integration-backed trajectory service and mutable room authorization. The
 * fixtures include raw paths, source text, provider IDs, account IDs, expired
 * retention, and cross-room decoys so leakage is a hard assertion.
 */

import { createServer } from "node:http";
import {
  buildReadSlice,
  buildReadView,
  type TrajectoryDetailRecord,
  type TrajectorySummaryRecord,
  type UUID,
} from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentHttpRequestAuthorization } from "../runtime/host-bridge.ts";
import { handleContextInspectorRoute } from "./context-inspector-routes.ts";

const ROOM = "00000000-0000-4000-8000-000000000101" as UUID;
const OTHER_ROOM = "00000000-0000-4000-8000-000000000102" as UUID;
const USER = "00000000-0000-4000-8000-000000000201" as UUID;
const RAW_REFERENCE = "gmail:account-private:message-private";
const RAW_BODY = "TOP SECRET END CANARY";
const RAW_PROVIDER = "provider-account-secret";

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
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

function summary(roomId = ROOM): TrajectorySummaryRecord {
  return {
    id: "trajectory-private-id",
    agentId: "agent-private-id",
    source: "chat",
    status: "completed",
    startTime: 1,
    endTime: 2,
    durationMs: 1,
    llmCallCount: 1,
    providerAccessCount: 0,
    totalPromptTokens: 312,
    totalCompletionTokens: 10,
    createdAt: new Date(1).toISOString(),
    roomId,
    metadata: { conversationId: roomId },
  };
}

function harness(options: {
  authorization: AgentHttpRequestAuthorization;
  detail?: TrajectoryDetailRecord;
  participantRooms?: UUID[];
}) {
  let participantRooms = options.participantRooms ?? [ROOM];
  let detail = options.detail ?? trajectory();
  let roomReads = 0;
  let participantReads = 0;
  const service = {
    async listTrajectories() {
      return { trajectories: [summary()], total: 1 };
    },
    async getTrajectoryDetail() {
      return detail;
    },
  };
  const runtime = {
    async getRoom(roomId: UUID) {
      roomReads += 1;
      return roomId === ROOM || roomId === OTHER_ROOM
        ? ({ id: roomId } as never)
        : null;
    },
    async getRoomsForParticipant() {
      participantReads += 1;
      return participantRooms;
    },
    getService(name: string) {
      return name === "trajectories" ? service : null;
    },
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await handleContextInspectorRoute({
      req,
      res,
      pathname: url.pathname,
      method: req.method ?? "GET",
      url,
      runtime: runtime as never,
      authorization: options.authorization,
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
    setParticipantRooms(next: UUID[]) {
      participantRooms = next;
    },
    setDetail(next: TrajectoryDetailRecord) {
      detail = next;
    },
    counts: () => ({ roomReads, participantReads }),
  };
}

describe("context inspector HTTP integration", () => {
  it("returns only the allowlisted redacted projection and explicit expired retention", async () => {
    const app = harness({ authorization: { ok: true, role: "OWNER" } });
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
    expect(app.counts().roomReads).toBe(1);
  });

  it("rejects unauthenticated, cross-room, revoked, and principal-free callers", async () => {
    const unauthenticated = harness({
      authorization: { ok: false, role: "NONE" },
    });
    expect(
      (
        await unauthenticated.request(
          `/api/context-inspector?conversationId=${ROOM}`,
        )
      ).response.status,
    ).toBe(401);

    const crossRoom = harness({
      authorization: { ok: true, role: "USER", principal: USER },
      participantRooms: [OTHER_ROOM],
    });
    expect(
      (await crossRoom.request(`/api/context-inspector?conversationId=${ROOM}`))
        .response.status,
    ).toBe(403);

    const revoked = harness({
      authorization: { ok: true, role: "USER", principal: USER },
    });
    expect(
      (await revoked.request(`/api/context-inspector?conversationId=${ROOM}`))
        .response.status,
    ).toBe(200);
    revoked.setParticipantRooms([]);
    expect(
      (await revoked.request(`/api/context-inspector?conversationId=${ROOM}`))
        .response.status,
    ).toBe(403);
    expect(revoked.counts().participantReads).toBe(2);

    const noPrincipal = harness({ authorization: { ok: true, role: "USER" } });
    expect(
      (
        await noPrincipal.request(
          `/api/context-inspector?conversationId=${ROOM}`,
        )
      ).response.status,
    ).toBe(403);
  });

  it("rejects tampered query state and a trajectory whose room changes", async () => {
    const app = harness({ authorization: { ok: true, role: "OWNER" } });
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

    const changed = harness({
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

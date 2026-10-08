import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActionResult,
  actionGateFailure,
  activeCommittedEffectReceipts,
  ChannelType,
  executePlannedToolCall,
  type Memory,
  ModelType,
  projectDeferredProviders,
  resolveActionGateFailure,
  type UUID,
  validateToolArgs,
} from "@elizaos/core";
import { renderContextObject } from "@elizaos/core/protocol";
import { expect, test, vi } from "vitest";
import { viewsAction } from "../../../packages/agent/src/actions/views.ts";
import { handleApprovalRoute } from "../../../packages/agent/src/api/approval-routes.ts";
import { readChatRequestPayload } from "../../../packages/agent/src/api/chat-routes.ts";
import {
  deviceRequestCredential,
  handleDeviceActionRoutes,
  requiresDeviceIdentity,
} from "../../../packages/agent/src/api/device-action-routes.ts";
import { buildUserMessages } from "../../../packages/agent/src/api/server-helpers.ts";
import {
  closeRuntimeViewRegistry,
  registerBuiltinViews,
} from "../../../packages/agent/src/api/views-registry.ts";
import { createMachineSession } from "../../../packages/app/src/api/auth/sessions.ts";
import { resolveAuthorizedRouteRole } from "../../../packages/app/src/api/auth.ts";
import { CORS_ALLOWED_HEADERS } from "../../../packages/app/src/api/server-cors.ts";
import {
  AuthStore,
  type DrizzleDatabase,
} from "../../../packages/app/src/services/auth-store.ts";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { calendarAction as standaloneCalendarAction } from "../../plugin-calendar/src/actions/calendar.ts";
import { calendarSourcesAction } from "../../plugin-calendar/src/actions/calendar-sources.ts";
import { notesPlugin } from "../../plugin-notes/src/plugin.ts";
import {
  NOTES_SERVICE_TYPE,
  NotesService,
} from "../../plugin-notes/src/service.ts";
import { NotesStore } from "../../plugin-notes/src/store.ts";
import { calendarAction } from "../../plugin-personal-assistant/src/actions/calendar.ts";
import { ownerDocumentsAction } from "../../plugin-personal-assistant/src/actions/document.ts";
import { householdCoordinationAction } from "../../plugin-personal-assistant/src/actions/household-coordination.ts";
import {
  ownerAlarmsAction,
  ownerGoalsAction,
  ownerRemindersAction,
  ownerRoutinesAction,
  ownerTodosAction,
} from "../../plugin-personal-assistant/src/actions/owner-surfaces.ts";
import { stage1Response } from "../src/__tests__/stage1/fixtures.ts";
import { runEvaluator } from "../src/runtime/evaluator.ts";
import {
  APPROVAL_SERVICE,
  ApprovalService,
} from "../src/services/approval/service.ts";
import { proposeDeviceAction } from "../src/services/device-actions/action.ts";
import {
  DeviceActionService,
  withDeviceActionTurn,
} from "../src/services/device-actions/service.ts";
import { createV5MessageContextObject } from "../src/services/message/context-assembly.ts";
import {
  projectDiscoverableContext,
  readContextRequests,
} from "../src/services/message/context-discovery.ts";
import { stage1ResponseStateProviderNames } from "../src/services/message/provider-state.ts";
import { collectDiscoveryCatalogActions } from "../src/services/message/tool-discovery.ts";
import { runV5MessageRuntimeStage1 } from "../src/services/message.ts";

// Real HTTP, session authentication, registered proposal tool, SQL migrations,
// and on-disk PGlite. All identities and requested content are synthetic.
test("device approval REST lifecycle survives restart and never duplicates claims", async () => {
  const directory = await mkdtemp(join(tmpdir(), "device-approval-e2e-"));
  let runtimeState = await createRealTestRuntime({
    characterName: "DeviceApprovalFixture",
    pgliteDir: directory,
    removePgliteDirOnCleanup: false,
  });
  let server: Server | undefined;
  try {
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    let authStore = new AuthStore(
      runtimeState.runtime.adapter.db as DrizzleDatabase,
    );
    const sessions: Record<string, string> = {};
    for (const [label, id] of [
      ["a", ownerA],
      ["b", ownerB],
    ]) {
      await authStore.createIdentity({
        id,
        kind: "machine",
        displayName: `Fixture ${label}`,
        createdAt: Date.now(),
        passwordHash: null,
      });
      sessions[label] = (
        await createMachineSession(authStore, { identityId: id, scopes: [] })
      ).session.id;
    }
    const device = randomUUID();
    const deviceKey = "a".repeat(64);
    const credentials = {
      subjectUserId: ownerA,
      installationId: device,
      deviceKey,
    };
    let mapsActionParameters:
      | { operation: unknown; operationKey: string; reason: string }
      | undefined;
    const start = async () => {
      authStore = new AuthStore(
        runtimeState.runtime.adapter.db as DrizzleDatabase,
      );
      await runtimeState.runtime.registerService(ApprovalService);
      await runtimeState.runtime.getServiceLoadPromise(APPROVAL_SERVICE);
      server = createServer(async (req, res) => {
        const resolved = await resolveAuthorizedRouteRole(req, {
          store: authStore,
          allowTrustedLocalBypass: !requiresDeviceIdentity(
            req,
            new URL(req.url ?? "/", "http://fixture").pathname,
          ),
          allowCookieAuth: false,
          allowBearerAuth: true,
        });
        const authorization = {
          ...resolved,
          role: resolved.ok ? resolved.role : ("NONE" as const),
        };
        const send = (response: typeof res, value: unknown, status = 200) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (req.url === "/api/approvals") {
          await handleApprovalRoute(
            req,
            res,
            "/api/approvals",
            "GET",
            { runtime: runtimeState.runtime },
            {
              json: send,
              error: (response, message, status) =>
                send(response, { error: message }, status),
              readJsonBody: async () => null,
            },
          );
          return;
        }
        if (req.url === "/api/maps-observation-fixture") {
          const credential = deviceRequestCredential(req, authorization);
          if (!credential || !mapsActionParameters) {
            send(res, { error: "Authenticated fixture turn required" }, 401);
            return;
          }
          try {
            await withDeviceActionTurn(
              runtimeState.runtime,
              credential,
              async () => {
                const payload = await readChatRequestPayload(req, res, {
                  error: (response, message, status) =>
                    send(response, { error: message }, status),
                  readJsonBody: async (request) => {
                    let value = "";
                    for await (const part of request) value += part;
                    return JSON.parse(value || "{}");
                  },
                });
                if (!payload) return;
                const { userMessage } = await buildUserMessages({
                  images: payload.images,
                  prompt: payload.prompt,
                  userId: memory.entityId,
                  agentId: runtimeState.runtime.agentId,
                  roomId: memory.roomId,
                  channelType: payload.channelType,
                  metadata: payload.metadata,
                });
                const action = await proposeDeviceAction.handler(
                  runtimeState.runtime,
                  userMessage,
                  undefined,
                  { parameters: mapsActionParameters },
                );
                send(res, { action, metadata: userMessage.content.metadata });
              },
            );
          } catch {
            send(res, { error: "Fixture turn rejected" }, 409);
          }
          return;
        }
        await handleDeviceActionRoutes({
          req,
          res,
          pathname: new URL(req.url!, "http://fixture").pathname,
          method: req.method!,
          runtime: runtimeState.runtime,
          authorization,
          json: send,
          error: (response, message, status) =>
            send(response, { error: message }, status),
          readJsonBody: async (request) => {
            let value = "";
            for await (const part of request) value += part;
            return JSON.parse(value || "{}");
          },
        });
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No fixture listener");
      return `http://127.0.0.1:${address.port}`;
    };
    let origin = await start();
    const request = async (
      path: string,
      body?: unknown,
      owner = "a",
      key = owner === "b" ? "b".repeat(64) : deviceKey,
      capabilities = "calendar.local-event.v1,notes.local-record.v1,reminders.local-record.v1",
    ) => {
      const result = await fetch(`${origin}/api/client-devices${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${sessions[owner] ?? "invalid-fixture-session"}`,
          "x-eliza-device-id": device,
          "x-eliza-device-key": key,
          "x-eliza-device-capabilities": capabilities,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: result.status, body: (await result.json()) as any };
    };
    const enrolled = await request("/register", { label: "Fixture phone" });
    expect(enrolled.status).toBe(200);
    expect(enrolled.body).toMatchObject({ userTextFormatVersion: 1 });
    const context = await request("/context");
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      agentId: runtimeState.runtime.agentId,
      subjectUserId: ownerA,
      installationId: device,
      enrollmentId: expect.any(String),
      scope: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect((await request("/context")).body).toEqual(context.body);
    expect(
      (await request("/context", undefined, "a", "c".repeat(64))).status,
    ).toBe(409);
    expect((await request("/context", undefined, "b", deviceKey)).status).toBe(
      409,
    );
    expect(
      (await request("/context", undefined, "invalid", deviceKey)).status,
    ).toBe(401);
    expect(
      (await request("/register", { label: "Fixture phone" })).status,
    ).toBe(200);
    for (const capabilities of [
      "",
      "notes.local-record.v1,notes.local-record.v1",
      "calendar.local-event.v1,",
      "unknown.v1",
      "calendar.local-event.v1,notes.local-record.v1,unknown.v1",
    ]) {
      expect(
        (await request("/proposals", undefined, "a", deviceKey, capabilities))
          .status,
      ).toBe(401);
    }
    for (const capabilities of [
      "notes.local-record.v1",
      "calendar.local-event.v1",
      "notes.local-record.v1,calendar.local-event.v1",
    ]) {
      expect(
        (await request("/proposals", undefined, "a", deviceKey, capabilities))
          .status,
      ).toBe(200);
    }
    expect(
      (await request("/register", { label: "Hijack" }, "a", "b".repeat(64)))
        .status,
    ).toBe(409);
    expect((await request("/proposals", undefined, "none")).status).toBe(401);
    expect((await request("/proposals", undefined, "b")).status).toBe(409);
    expect(
      (await request("/register", { label: "Other owner phone" }, "b")).status,
    ).toBe(200);
    const otherContext = await request("/context", undefined, "b");
    expect(otherContext.status).toBe(200);
    expect(otherContext.body.subjectUserId).toBe(ownerB);
    expect(otherContext.body.scope).not.toBe(context.body.scope);
    expect(otherContext.body.enrollmentId).not.toBe(context.body.enrollmentId);
    expect(
      (await request("/proposals", undefined, "b")).body.proposals,
    ).toEqual([]);
    const memory = {
      id: randomUUID(),
      agentId: runtimeState.runtime.agentId,
      entityId: ownerA,
      roomId: randomUUID(),
      content: { text: "Create fixture note" },
    } as Memory;
    const parameters = {
      operation: {
        type: "create_note",
        title: "Fixture note",
        body: "Synthetic test data only",
      },
      operationKey: "fixture-note-1",
      reason: "Requested by test owner",
    };
    expect(
      await proposeDeviceAction.validate(runtimeState.runtime, memory),
    ).toBe(false);
    const propose = () =>
      withDeviceActionTurn(runtimeState.runtime, credentials, async () => {
        expect(
          await proposeDeviceAction.validate(runtimeState.runtime, memory),
        ).toBe(true);
        return proposeDeviceAction.handler(
          runtimeState.runtime,
          memory,
          undefined,
          { parameters },
        );
      });
    const firstProposal = await propose();
    const repeatedProposal = await propose();
    expect(firstProposal && firstProposal.effectReceipts).toMatchObject([
      {
        operation: "device.create_note",
        outcome: "preview",
        idempotency: { replayed: false },
      },
    ]);
    expect(repeatedProposal && repeatedProposal.effectReceipts).toMatchObject([
      {
        operation: "device.create_note",
        outcome: "preview",
        idempotency: { replayed: false },
      },
    ]);
    expect(firstProposal && firstProposal.data).toMatchObject({
      executed: false,
      awaitingUserInput: true,
      approvalRequired: true,
    });
    expect(
      firstProposal && firstProposal.data?.approvalPersistence,
    ).toMatchObject({
      operation: "device.approval.create",
      outcome: "applied",
    });
    expect(
      repeatedProposal && repeatedProposal.data?.approvalPersistence,
    ).toMatchObject({
      operation: "device.approval.create",
      outcome: "noop",
      idempotency: { replayed: true },
    });
    const evaluate = async (
      result: ActionResult,
      applied: boolean,
      receiptId?: string,
    ) => {
      const context = { id: "device-receipt-evaluator", events: [] };
      return runEvaluator({
        runtime: {
          redactSecrets: (text) => text,
          useModel: async () =>
            JSON.stringify({
              thought: "Evaluate the recorded device operation.",
              success: true,
              decision: "FINISH",
              replyEffectStatus: applied ? "applied" : "non_applied",
              messageToUser: applied
                ? "Your note was created."
                : "Review and approve the pending request on your phone.",
              ...(receiptId ? { effectReceiptIds: [receiptId] } : {}),
            }),
        },
        context,
        trajectory: {
          context,
          steps: [{ iteration: 1, result }],
          archivedSteps: [],
          plannedQueue: [],
          evaluatorOutputs: [],
        },
      });
    };
    if (!firstProposal || !repeatedProposal)
      throw new Error("Missing real proposal result");
    for (const pending of [firstProposal, repeatedProposal]) {
      const spoofed = await evaluate(
        pending,
        true,
        pending.effectReceipts?.[0]?.receiptId,
      );
      expect(spoofed.success).toBe(false);
      expect(spoofed.decision).toBe("CONTINUE");
      expect(spoofed.messageToUser).toBeUndefined();
      const review = await evaluate(pending, false);
      expect(review.decision).toBe("FINISH");
      expect(review.messageToUser).toContain("Review and approve");
    }

    let proposals = (await request("/proposals")).body.proposals;
    expect(proposals).toHaveLength(1);
    const { id, digest } = proposals[0];
    const aggregate = await fetch(`${origin}/api/approvals`).then((result) =>
      result.json(),
    );
    expect(aggregate.approvals).toEqual([]);
    expect(aggregate.pending).toEqual([]);
    expect(proposals[0].state).toBe("pending");
    expect(proposals[0].execution).toBeNull();
    expect((await request(`/proposals/${id}/claim`, { digest })).status).toBe(
      409,
    );
    expect(
      (
        await request(`/proposals/${id}/decision`, {
          digest: "wrong",
          decision: "approve",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          `/proposals/${id}/decision`,
          { digest, decision: "approve" },
          "b",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(`/proposals/${id}/decision`, {
          digest,
          decision: "approve",
        })
      ).status,
    ).toBe(200);
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
    server = undefined;
    await runtimeState.cleanup();
    runtimeState = await createRealTestRuntime({
      characterName: "DeviceApprovalFixture",
      pgliteDir: directory,
      removePgliteDirOnCleanup: false,
    });
    origin = await start();
    expect((await request("/context")).body).toEqual(context.body);
    proposals = (await request("/proposals")).body.proposals;
    expect(proposals[0].state).toBe("approved");
    const claims = await Promise.all([
      request(`/proposals/${id}/claim`, { digest }),
      request(`/proposals/${id}/claim`, { digest }),
    ]);
    expect(claims.map((result) => result.status).sort()).toEqual([200, 409]);
    const claim = claims.find((result) => result.status === 200)!.body.proposal;
    expect(claim.execution.dispatchStartedAt).toBeTruthy();
    const uncompleted = await propose();
    expect(
      activeCommittedEffectReceipts(
        uncompleted ? (uncompleted.effectReceipts ?? []) : [],
      ),
    ).toEqual([]);

    const receipt = {
      digest,
      attemptId: claim.execution.attemptId,
      receipt: { outcome: "applied", operationId: "fixture-native-note-1" },
    };
    expect(
      (
        await request(`/proposals/${id}/receipt`, {
          ...receipt,
          attemptId: randomUUID(),
        })
      ).status,
    ).toBe(409);
    expect(
      (await request(`/proposals/${id}/receipt`, receipt)).body.proposal.state,
    ).toBe("done");
    expect((await request(`/proposals/${id}/receipt`, receipt)).status).toBe(
      200,
    );
    expect((await request(`/proposals/${id}/claim`, { digest })).status).toBe(
      409,
    );
    expect(
      (
        await request(`/proposals/${id}/receipt`, {
          ...receipt,
          receipt: { outcome: "unknown" },
        })
      ).status,
    ).toBe(409);
    await expect(
      new DeviceActionService(runtimeState.runtime).propose(
        credentials,
        { type: "execute_plugin", plugin: "arbitrary" },
        "bad",
        "bad",
      ),
    ).rejects.toThrow();
    const completedLegacy = await propose();
    if (!completedLegacy) throw new Error("Missing completed legacy result");
    expect(completedLegacy.data).toMatchObject({
      executed: false,
      historicalCompletion: true,
      operationType: "create_note",
      nativeOperationId: "fixture-native-note-1",
    });
    const grounded = await evaluate(
      completedLegacy,
      true,
      completedLegacy.effectReceipts?.[0]?.receiptId,
    );
    expect(grounded.success).toBe(true);
    expect(grounded.decision).toBe("FINISH");

    expect(completedLegacy && completedLegacy.effectReceipts).toMatchObject([
      {
        operation: "device.create_note",
        outcome: "applied",
        resource: { kind: "device.operation", id: "fixture-native-note-1" },
        idempotency: { replayed: true },
        commit: { kind: "provider_accepted", id: "fixture-native-note-1" },
      },
    ]);
    const service = new DeviceActionService(runtimeState.runtime);
    await expect(
      service.propose(
        credentials,
        { type: "create_note", title: "Changed", body: "Different" },
        "fixture-note-1",
        "Requested by test owner",
      ),
    ).rejects.toThrow();
    const reminder = await service.propose(
      credentials,
      {
        type: "create_reminder",
        title: "Fixture reminder",
        dueAt: "2030-01-01T12:00:00Z",
      },
      "reminder-1",
      "Fixture",
    );
    const view = await service.propose(
      credentials,
      { type: "open_view", view: "workflows" },
      "view-1",
      "Fixture",
    );
    const browser = await service.propose(
      credentials,
      { type: "browser_navigate", url: "https://example.com/" },
      "browser-1",
      "Fixture",
    );
    const pending = (await request("/proposals")).body.proposals;
    const reminderDigest = pending.find(
      (item: any) => item.id === reminder.id,
    ).digest;
    expect(
      (
        await request(`/proposals/${reminder.id}/decision`, {
          digest: reminderDigest,
          decision: "reject",
        })
      ).body.proposal.state,
    ).toBe("rejected");
    expect(
      (
        await request(`/proposals/${reminder.id}/claim`, {
          digest: reminderDigest,
        })
      ).status,
    ).toBe(409);
    const viewDigest = pending.find((item: any) => item.id === view.id).digest;
    expect(
      (await request(`/proposals/${view.id}/claim`, { digest: viewDigest }))
        .status,
    ).toBe(409);
    expect(
      pending.find((item: any) => item.id === view.id).payload.operation,
    ).toEqual({ type: "open_view", view: "workflows" });
    expect(
      (
        await request(`/proposals/${view.id}/decision`, {
          digest: viewDigest,
          decision: "approve",
        })
      ).status,
    ).toBe(200);
    const viewClaim = await request(`/proposals/${view.id}/claim`, {
      digest: viewDigest,
    });
    expect(viewClaim.status).toBe(200);
    expect(viewClaim.body.proposal.state).toBe("executing");
    const viewReceipt = await request(`/proposals/${view.id}/receipt`, {
      digest: viewDigest,
      attemptId: viewClaim.body.proposal.execution.attemptId,
      receipt: { outcome: "applied", operationId: "fixture-open-workflows-1" },
    });
    expect(viewReceipt.status).toBe(200);
    expect(viewReceipt.body.proposal.state).toBe("done");
    expect(
      (await request(`/proposals/${view.id}/claim`, { digest: viewDigest }))
        .status,
    ).toBe(409);
    const browserDigest = pending.find(
      (item: any) => item.id === browser.id,
    ).digest;
    await request(`/proposals/${browser.id}/decision`, {
      digest: browserDigest,
      decision: "approve",
    });
    const browserClaim = await request(`/proposals/${browser.id}/claim`, {
      digest: browserDigest,
    });
    expect(browserClaim.status).toBe(200);
    // Simulate loss of the claim response: restart while dispatch outcome is unknown.
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    await runtimeState.cleanup();
    runtimeState = await createRealTestRuntime({
      characterName: "DeviceApprovalFixture",
      pgliteDir: directory,
      removePgliteDirOnCleanup: false,
    });
    origin = await start();
    expect(
      (
        await request(`/proposals/${browser.id}/claim`, {
          digest: browserDigest,
        })
      ).status,
    ).toBe(409);
    const uncertain = await request(`/proposals/${browser.id}/receipt`, {
      digest: browserDigest,
      attemptId: browserClaim.body.proposal.execution.attemptId,
      receipt: { outcome: "unknown", code: "claim_response_lost" },
    });
    expect(uncertain.body.proposal.state).toBe("reconciliation_required");
    const unknownOutcome = await withDeviceActionTurn(
      runtimeState.runtime,
      credentials,
      () =>
        proposeDeviceAction.handler(runtimeState.runtime, memory, undefined, {
          parameters: {
            operation: {
              type: "browser_navigate",
              url: "https://example.com/",
            },
            operationKey: "browser-1",
            reason: "Fixture",
          },
        }),
    );
    if (!unknownOutcome) throw new Error("Missing uncertain result");
    expect(unknownOutcome.effectReceipts).toMatchObject([
      {
        outcome: "failed",
        failure: { acceptance: "unknown", retryable: false },
      },
    ]);
    const falseUnknownClaim = await evaluate(
      unknownOutcome,
      true,
      unknownOutcome.effectReceipts?.[0]?.receiptId,
    );
    expect(falseUnknownClaim.success).toBe(false);
    expect(falseUnknownClaim.messageToUser).toBeUndefined();

    expect(
      (
        await request(`/proposals/${browser.id}/claim`, {
          digest: browserDigest,
        })
      ).status,
    ).toBe(409);
    const reconciliation = {
      digest: browserDigest,
      attemptId: browserClaim.body.proposal.execution.attemptId,
      resolution: {
        confirmed: true,
        outcome: "applied",
        operationId: "fixture-browser-tab-1",
      },
    };
    expect(
      (
        await request(`/proposals/${browser.id}/reconciliation`, {
          ...reconciliation,
          resolution: { ...reconciliation.resolution, confirmed: false },
        })
      ).status,
    ).toBe(409);
    expect(
      (await request(`/proposals/${browser.id}/reconciliation`, reconciliation))
        .body.proposal.state,
    ).toBe("done");
    expect(
      (await request(`/proposals/${browser.id}/reconciliation`, reconciliation))
        .status,
    ).toBe(200);
    // Calendar operations share the same real queue and immutable provider receipt path.
    const calendarCredentials = {
      ...credentials,
      capabilities: ["calendar.local-event.v1"],
    };
    const source = { sourceId: "19", sourceRevision: "a".repeat(64) };
    const target = { ...source, eventId: "71", revision: "b".repeat(64) };
    const fields = {
      title: "Synthetic event",
      description: "Approved selected content",
      location: "Here",
      start: "2027-01-01T12:00:00.000Z",
      end: "2027-01-01T13:00:00.000Z",
      timeZone: "UTC",
    };
    const calendarService = new DeviceActionService(runtimeState.runtime);
    await expect(
      calendarService.propose(
        credentials,
        { type: "calendar_create", source, fields },
        "calendar-missing-cap",
        "fixture",
      ),
    ).rejects.toThrow();
    for (const kind of [
      "calendar_create",
      "calendar_read_selected",
      "calendar_update",
      "calendar_delete",
    ] as const) {
      const operation =
        kind === "calendar_create"
          ? { type: kind, source, fields }
          : kind === "calendar_update"
            ? { type: kind, target, fields }
            : { type: kind, target };
      const proposed = await calendarService.propose(
        calendarCredentials,
        operation,
        kind,
        "fixture",
      );
      const repeated = await calendarService.propose(
        calendarCredentials,
        operation,
        kind,
        "fixture",
      );
      expect(repeated.id).toBe(proposed.id);
      const item = (await request("/proposals")).body.proposals.find(
        (p: any) => p.id === proposed.id,
      );
      expect(item.state).toBe("pending");
      expect(item.execution).toBeNull();
      expect(
        (
          await request(
            `/proposals/${item.id}/decision`,
            { digest: item.digest, decision: "approve" },
            "b",
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await request(`/proposals/${item.id}/decision`, {
            digest: item.digest,
            decision: "approve",
          })
        ).status,
      ).toBe(200);
      const claimed = await request(`/proposals/${item.id}/claim`, {
        digest: item.digest,
      });
      expect(claimed.status).toBe(200);
      expect(
        (await request(`/proposals/${item.id}/claim`, { digest: item.digest }))
          .status,
      ).toBe(409);
      const result = {
        version: 1,
        kind,
        sourceId: "19",
        eventId: "71",
        revision:
          kind === "calendar_read_selected" || kind === "calendar_delete"
            ? target.revision
            : "c".repeat(64),
        ...(kind === "calendar_read_selected" ? { fields } : {}),
      };
      const receipt = {
        digest: item.digest,
        attemptId: claimed.body.proposal.execution.attemptId,
        receipt: { outcome: "applied", operationId: `native-${kind}`, result },
      };
      expect(
        (
          await request(`/proposals/${item.id}/receipt`, {
            ...receipt,
            receipt: {
              ...receipt.receipt,
              result: { ...result, sourceId: "other" },
            },
          })
        ).status,
      ).not.toBe(200);
      expect(
        (await request(`/proposals/${item.id}/receipt`, receipt)).body.proposal
          .state,
      ).toBe("done");
      expect(
        (await request(`/proposals/${item.id}/receipt`, receipt)).status,
      ).toBe(200);
      const canonical = (await request("/proposals")).body.proposals.find(
        (p: any) => p.id === item.id,
      );
      expect(canonical.execution.providerReceipt.result).toEqual(result);
      const retrieved = await withDeviceActionTurn(
        runtimeState.runtime,
        calendarCredentials,
        () =>
          proposeDeviceAction.handler(runtimeState.runtime, memory, undefined, {
            parameters: { operation, operationKey: kind, reason: "fixture" },
          }),
      );
      expect(
        activeCommittedEffectReceipts(
          retrieved ? (retrieved.effectReceipts ?? []) : [],
        ),
      ).toHaveLength(kind.endsWith("_read_selected") ? 0 : 1);
      expect(retrieved && retrieved.data).toMatchObject({
        proposalId: item.id,
        executed: false,
        result,
      });
      expect(
        (await request("/proposals")).body.proposals.filter(
          (p: any) => p.id === item.id,
        ),
      ).toHaveLength(1);
    }
    {
      // Notes operations share the same real queue and immutable provider receipt path.
      const notesCredentials = {
        ...credentials,
        capabilities: ["notes.local-record.v1"],
      };
      const source = { sourceId: "19", sourceRevision: "a".repeat(64) };
      const target = { ...source, noteId: "71", revision: "b".repeat(64) };
      const fields = {
        title: "",
        body: "Approved selected Notes content",
      };
      const notesService = new DeviceActionService(runtimeState.runtime);
      await expect(
        notesService.propose(
          credentials,
          { type: "notes_read_selected", target },
          "notes-missing-cap",
          "fixture",
        ),
      ).rejects.toThrow();
      for (const kind of [
        "notes_read_selected",
        "notes_update",
        "notes_delete",
      ] as const) {
        const operation =
          kind === "notes_update"
            ? { type: kind, target, fields }
            : { type: kind, target };
        const proposed = await notesService.propose(
          notesCredentials,
          operation,
          kind,
          "fixture",
        );
        const repeated = await notesService.propose(
          notesCredentials,
          operation,
          kind,
          "fixture",
        );
        expect(repeated.id).toBe(proposed.id);
        const item = (await request("/proposals")).body.proposals.find(
          (p: any) => p.id === proposed.id,
        );
        expect(item.state).toBe("pending");
        expect(item.execution).toBeNull();
        expect(
          (
            await request(
              `/proposals/${item.id}/decision`,
              { digest: item.digest, decision: "approve" },
              "b",
            )
          ).status,
        ).toBe(409);
        expect(
          (
            await request(`/proposals/${item.id}/decision`, {
              digest: item.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(200);
        const claimed = await request(`/proposals/${item.id}/claim`, {
          digest: item.digest,
        });
        expect(claimed.status).toBe(200);
        expect(
          (
            await request(`/proposals/${item.id}/claim`, {
              digest: item.digest,
            })
          ).status,
        ).toBe(409);
        const result = {
          version: 1,
          kind,
          sourceId: "19",
          noteId: "71",
          revision:
            kind === "notes_read_selected" || kind === "notes_delete"
              ? target.revision
              : "c".repeat(64),
          ...(kind === "notes_read_selected" ? { fields } : {}),
        };
        const receipt = {
          digest: item.digest,
          attemptId: claimed.body.proposal.execution.attemptId,
          receipt: {
            outcome: "applied",
            operationId: `native-${kind}`,
            result,
          },
        };
        expect(
          (
            await request(`/proposals/${item.id}/receipt`, {
              ...receipt,
              receipt: {
                ...receipt.receipt,
                result: { ...result, sourceId: "other" },
              },
            })
          ).status,
        ).not.toBe(200);
        expect(
          (await request(`/proposals/${item.id}/receipt`, receipt)).body
            .proposal.state,
        ).toBe("done");
        expect(
          (await request(`/proposals/${item.id}/receipt`, receipt)).status,
        ).toBe(200);
        const canonical = (await request("/proposals")).body.proposals.find(
          (p: any) => p.id === item.id,
        );
        expect(canonical.execution.providerReceipt.result).toEqual(result);
        const retrieved = await withDeviceActionTurn(
          runtimeState.runtime,
          notesCredentials,
          () =>
            proposeDeviceAction.handler(
              runtimeState.runtime,
              memory,
              undefined,
              {
                parameters: {
                  operation,
                  operationKey: kind,
                  reason: "fixture",
                },
              },
            ),
        );
        expect(
          activeCommittedEffectReceipts(
            retrieved ? (retrieved.effectReceipts ?? []) : [],
          ),
        ).toHaveLength(kind.endsWith("_read_selected") ? 0 : 1);
        expect(retrieved && retrieved.data).toMatchObject({
          proposalId: item.id,
          executed: false,
          result,
        });
        expect(
          (await request("/proposals")).body.proposals.filter(
            (p: any) => p.id === item.id,
          ),
        ).toHaveLength(1);
      }
    }
    {
      const capability = "clock.handoff.v1";
      const allCapabilities =
        "calendar.local-event.v1,notes.local-record.v1,reminders.local-record.v1,maps.selected-read.v1,clock.handoff.v1";
      const enrolled = await request(
        "/register",
        { label: "Fixture phone", workflowProtocol: 1 },
        "a",
        deviceKey,
        allCapabilities,
      );
      expect(enrolled.status).toBe(200);
      expect([...enrolled.body.capabilities].sort()).toEqual(
        [
          ...allCapabilities.split(","),
          "reminders.local-record.v2",
          "reminders.create.v1",
          "clock.handoff.v2",
          "clock.alarms.v1",
        ].sort(),
      );
      expect(enrolled.body.capabilities).toContain("clock.handoff.v1");
      expect(
        (
          await request(
            "/proposals",
            undefined,
            "a",
            deviceKey,
            allCapabilities,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await request(
            "/proposals",
            undefined,
            "a",
            deviceKey,
            allCapabilities + ",unknown.v1",
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await request(
            "/proposals",
            undefined,
            "a",
            deviceKey,
            allCapabilities + ",clock.handoff.v1",
          )
        ).status,
      ).toBe(401);

      const operationSchema = proposeDeviceAction.parameters!.find(
        (p) => p.name === "operation",
      )!.schema;
      const clockSchemas = operationSchema.anyOf!.filter((p) =>
        p.properties?.type.enum?.includes("clock_handoff"),
      );
      expect(clockSchemas).toHaveLength(5);
      expect(clockSchemas.every((p) => p.additionalProperties === false)).toBe(
        true,
      );
      expect(proposeDeviceAction.description).toContain(
        "Never invent the phone timezone or substitute an approximate reminder for an alarm",
      );

      const c = { ...credentials, capabilities: [capability] };
      const clockRequest = (path: string, body?: unknown) =>
        request(path, body, "a", deviceKey, capability);
      const service = new DeviceActionService(runtimeState.runtime);
      const broaderBefore = await service.list(credentials);
      for (const operation of [
        { type: "open_view", view: "home" },
        { type: "create_note", title: "Scope fixture", body: "Exact fixture" },
        {
          type: "create_reminder",
          title: "Scope fixture",
          dueAt: "2030-01-01T12:00:00Z",
        },
        { type: "browser_navigate", url: "https://example.com/" },
      ])
        await expect(
          service.propose(
            c,
            operation,
            `clock-only-${operation.type}`,
            "Scope fixture",
          ),
        ).rejects.toThrow("capability unavailable");
      expect((await service.list(credentials)).map((item) => item.id)).toEqual(
        broaderBefore.map((item) => item.id),
      );
      expect(
        (await service.list(c)).every(
          (item) => item.payload.operation.type === "clock_handoff",
        ),
      ).toBe(true);
      const globalSchema = JSON.stringify(proposeDeviceAction.parameters);
      const clockContext = await withDeviceActionTurn(
        runtimeState.runtime,
        c,
        () =>
          createV5MessageContextObject({
            runtime: runtimeState.runtime,
            message: {
              id: randomUUID(),
              roomId: randomUUID(),
              entityId: ownerA,
              agentId: runtimeState.runtime.agentId,
              content: {
                text: "Go home.",
                source: "client_chat",
                channelType: "DM",
                metadata: { uiView: "chat", uiViewPath: "/chat" },
              },
            } as Memory,
            state: { values: {}, data: {}, text: "" },
            selectedContexts: ["general"],
            includeTools: true,
            userRoles: ["OWNER"],
            preselectedActions: [proposeDeviceAction],
          }),
      );
      const capabilityInstruction = clockContext.events.find(
        (event) => event.id === "authenticated-phone-capability",
      );
      const nativeGuidance =
        capabilityInstruction?.type === "instruction"
          ? capabilityInstruction.content
          : undefined;
      expect(nativeGuidance).not.toContain("candidateActionNames");
      expect(nativeGuidance).toContain(
        "select general planning and pending effect status",
      );
      expect(nativeGuidance).toContain(
        'DISCOVER_ACTIONS with names=["PROPOSE_DEVICE_ACTION"]',
      );
      expect(nativeGuidance).toContain("if that exact tool is not loaded");
      expect(nativeGuidance).toContain(
        'Use operation={"type":"clock_handoff","action":"show"} to open Android Clock alarms without creating or changing alarms.',
      );
      expect(nativeGuidance).toContain(
        "show is not generic open_view or VIEWS_SHOW",
      );
      expect(nativeGuidance).toContain(
        "Supported Clock actions are set, show, dismiss and snooze.",
      );
      expect(
        [
          ...new Set(
            clockSchemas.map((branch) => branch.properties?.action.enum?.[0]),
          ),
        ].sort(),
      ).toEqual(["dismiss", "set", "show", "snooze"]);
      for (const capabilities of [
        undefined,
        [],
        ["unknown.v1"],
        ["clock.handoff.v2"],
        ["clock.handoff.v1", "notes.local-record.v1"],
      ]) {
        const currentContext = await withDeviceActionTurn(
          runtimeState.runtime,
          { ...credentials, capabilities },
          () =>
            createV5MessageContextObject({
              runtime: runtimeState.runtime,
              message: {
                id: randomUUID(),
                roomId: randomUUID(),
                entityId: ownerA,
                agentId: runtimeState.runtime.agentId,
                content: {
                  text: "Open Android Clock alarms.",
                  source: "client_chat",
                },
              } as Memory,
              state: { values: {}, data: {}, text: "" },
              selectedContexts: ["general"],
              includeTools: true,
              userRoles: ["OWNER"],
              preselectedActions: [proposeDeviceAction],
            }),
        );
        const instruction = currentContext.events.find(
          (event) => event.id === "authenticated-phone-capability",
        );
        const guidance =
          instruction?.type === "instruction" ? instruction.content : "";
        const tool = currentContext.events.find(
          (event) =>
            event.type === "tool" &&
            event.tool.name === "PROPOSE_DEVICE_ACTION",
        );
        const branches =
          tool?.type === "tool"
            ? tool.tool.parameters?.properties?.operation.anyOf
            : [];
        const clockSupported =
          capabilities?.some(
            (value) =>
              value === "clock.handoff.v1" || value === "clock.handoff.v2",
          ) === true;
        expect(
          guidance.includes(
            'Use operation={"type":"clock_handoff","action":"show"}',
          ),
        ).toBe(clockSupported);
        if (clockSupported) {
          expect(
            branches?.some((branch) =>
              branch.properties?.type.enum?.includes("clock_handoff"),
            ),
          ).toBe(true);
        } else {
          // Legacy broad schemas are unchanged; capability admission still rejects Clock.
          await expect(
            service.propose(
              { ...credentials, capabilities },
              { type: "clock_handoff", action: "show" },
              `unsupported-clock-show-${String(capabilities)}`,
              "Unsupported scope fixture",
            ),
          ).rejects.toThrow("capability unavailable");
        }
      }
      const inferredClock = clockContext.events.find(
        (event: any) =>
          event.type === "tool" && event.tool.name === "PROPOSE_DEVICE_ACTION",
      ) as any;
      expect(
        inferredClock.tool.parameters.properties.operation.anyOf.every(
          (branch: any) => branch.properties.type.enum[0] === "clock_handoff",
        ),
      ).toBe(true);
      expect(
        inferredClock.tool.parameters.properties.operation.anyOf.some(
          (branch: any) => branch.properties.days,
        ),
      ).toBe(false);
      expect(JSON.stringify(proposeDeviceAction.parameters)).toBe(globalSchema);
      const set = {
        type: "clock_handoff",
        action: "set",
        hour: 7,
        minute: 30,
        label: "Clock fixture",
        timeZone: "UTC",
      };
      const observation = {
        view: "home",
        revision: 7,
        sensitive: false,
        timeZone: "UTC",
      };
      const proposeOverHttp = async (
        operation: unknown,
        context: unknown,
        operationKey = randomUUID(),
        capabilities = capability,
      ) => {
        mapsActionParameters = {
          operation,
          operationKey,
          reason: "Clock fixture",
        };
        const response = await fetch(`${origin}/api/maps-observation-fixture`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${sessions.a}`,
            "x-eliza-device-id": device,
            "x-eliza-device-key": deviceKey,
            "x-eliza-device-capabilities": capabilities,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: "Review Clock handoff",
            metadata: { clientDevice: { context } },
          }),
        });
        return {
          status: response.status,
          body: (await response.json()) as any,
        };
      };
      await expect(
        service.propose(
          credentials,
          set,
          "clock-no-cap",
          "Clock fixture",
          observation,
        ),
      ).rejects.toThrow();
      for (const operation of [
        { ...set, hour: 24 },
        { ...set, minute: -1 },
        { ...set, hour: 7.5 },
        { ...set, label: "x".repeat(201) },
        { ...set, timeZone: "Not/AZone" },
        { ...set, alarmCreated: true },
        { type: "clock_handoff", action: "show", hour: 7 },
        { type: "clock_handoff", action: "dismiss", alarmId: "other" },
        { type: "clock_handoff", action: "snooze", snoozeMinutes: 0 },
        { type: "clock_handoff", action: "snooze", snoozeMinutes: 61 },
        { ...set, days: [] },
        { ...set, days: [1, 2, 3, 4, 5, 6, 7] },
      ])
        expect((await proposeOverHttp(operation, observation)).status).toBe(
          409,
        );
      // The model's valid zone cannot replace missing/different current HTTP observation.
      for (const context of [
        undefined,
        { ...observation, timeZone: undefined },
        { ...observation, timeZone: "America/New_York" },
        { ...observation, sensitive: true },
      ]) {
        expect((await proposeOverHttp(set, context)).status).toBe(409);
      }
      const operations = [
        set,
        { type: "clock_handoff", action: "show" },
        { type: "clock_handoff", action: "dismiss" },
        { type: "clock_handoff", action: "snooze", snoozeMinutes: 10 },
        set,
      ];
      for (const [index, status] of [
        "opened",
        "unavailable",
        "denied",
        "failed",
        "unknown",
      ].entries()) {
        const operation = operations[index];
        const key = `clock-${status}`;
        const proposed = await proposeOverHttp(operation, observation, key);
        expect(proposed.status).toBe(200);
        expect(proposed.body.metadata.clientDevice.context.timeZone).toBe(
          "UTC",
        );
        const id = proposed.body.action.data.proposalId;
        const listed = await clockRequest("/proposals");
        const pending = listed.body.proposals.find((p: any) => p.id === id);
        expect(pending.payload.operation).toEqual(operation);
        expect(
          (
            await clockRequest(`/proposals/${id}/claim`, {
              digest: pending.digest,
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await clockRequest(`/proposals/${id}/decision`, {
              digest: pending.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(200);
        const claim = await clockRequest(`/proposals/${id}/claim`, {
          digest: pending.digest,
        });
        expect(claim.status).toBe(200);
        const attemptId = claim.body.proposal.execution.attemptId;
        const endpoint = `/proposals/${id}/receipt`;
        for (const result of [
          {
            kind: "clock-handoff",
            action: operation.action,
            status: "created",
          },
          {
            kind: "clock-handoff",
            action: operation.action,
            status: "opened",
            alarmCreated: true,
          },
          { kind: "clock-handoff", action: "wrong", status: "opened" },
        ]) {
          expect(
            (
              await clockRequest(endpoint, {
                digest: pending.digest,
                attemptId,
                receipt: {
                  outcome: "applied",
                  operationId: randomUUID(),
                  result,
                },
              })
            ).status,
          ).toBe(409);
        }
        const receipt = {
          outcome:
            status === "opened"
              ? "applied"
              : status === "unknown"
                ? "unknown"
                : "failed",
          operationId: randomUUID(),
          result: { kind: "clock-handoff", action: operation.action, status },
        };
        const recorded = await clockRequest(endpoint, {
          digest: pending.digest,
          attemptId,
          receipt,
        });
        expect(recorded.status).toBe(200);
        expect(recorded.body.proposal.execution.providerReceipt.result).toEqual(
          receipt.result,
        );
        expect(
          (
            await clockRequest(`/proposals/${id}/claim`, {
              digest: pending.digest,
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await clockRequest(endpoint, {
              digest: pending.digest,
              attemptId,
              receipt,
            })
          ).status,
        ).toBe(200);
        if (status === "opened") {
          const historical = await proposeOverHttp(
            operation,
            { ...observation, timeZone: "America/New_York" },
            key,
          );
          expect(historical.status).toBe(200);
          expect(historical.body.action.data.result.status).toBe("opened");
          expect(historical.body.action.text).toContain(
            "not proof of its final alarm state",
          );
          expect(historical.body.action.text).toContain(
            "The request may already have changed an alarm",
          );
          expect(historical.body.action.text).toContain(
            "No new dispatch occurred.",
          );
          expect(historical.body.action.data.executed).toBe(false);
        }
      }
      const repeatCapability = "clock.handoff.v2";
      const repeatRequest = (path: string, body?: unknown) =>
        request(path, body, "a", deviceKey, repeatCapability);
      for (const days of [
        null,
        "weekdays",
        ["2", "3"],
        [0],
        [8],
        [2.5],
        [2, 2],
        [1, 2, 3, 4, 5, 6, 7, 1],
      ]) {
        expect(
          (
            await proposeOverHttp(
              { ...set, days },
              observation,
              randomUUID(),
              repeatCapability,
            )
          ).status,
        ).toBe(409);
      }
      const repeatSetSchema = clockSchemas.find((schema) =>
        schema.required?.includes("days"),
      );
      expect(repeatSetSchema?.properties?.days.items?.enum).toEqual([
        1, 2, 3, 4, 5, 6, 7,
      ]);
      const repeatDigests = new Set<string>();
      for (const days of [[], [1, 2, 3, 4, 5, 6, 7], [2, 3, 4, 5, 6]]) {
        const operation = { ...set, hour: 9, minute: 0, days };
        const key = randomUUID();
        const proposed = await proposeOverHttp(
          operation,
          observation,
          key,
          repeatCapability,
        );
        expect(proposed.status).toBe(200);
        const id = proposed.body.action.data.proposalId;
        const pending = (await repeatRequest("/proposals")).body.proposals.find(
          (proposal: any) => proposal.id === id,
        );
        expect(pending.payload.operation).toEqual(operation);
        repeatDigests.add(pending.digest);
        expect(
          (
            await repeatRequest(`/proposals/${id}/claim`, {
              digest: pending.digest,
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await clockRequest(`/proposals/${id}/decision`, {
              digest: pending.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await repeatRequest(`/proposals/${id}/decision`, {
              digest: pending.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await clockRequest(`/proposals/${id}/claim`, {
              digest: pending.digest,
            })
          ).status,
        ).toBe(409);
        const claimed = await repeatRequest(`/proposals/${id}/claim`, {
          digest: pending.digest,
        });
        expect(claimed.status).toBe(200);
        expect(claimed.body.proposal.payload.operation.days).toEqual(days);
        const body = {
          digest: pending.digest,
          attemptId: claimed.body.proposal.execution.attemptId,
          receipt: {
            outcome: "applied",
            operationId: randomUUID(),
            result: { kind: "clock-handoff", action: "set", status: "opened" },
          },
        };
        expect(
          (await clockRequest(`/proposals/${id}/receipt`, body)).status,
        ).toBe(409);
        const recorded = await repeatRequest(`/proposals/${id}/receipt`, body);
        expect(recorded.status).toBe(200);
        expect(recorded.body.proposal.payload.operation.days).toEqual(days);
        expect(
          (await repeatRequest(`/proposals/${id}/receipt`, body)).status,
        ).toBe(200);
        const historical = await proposeOverHttp(
          operation,
          undefined,
          key,
          repeatCapability,
        );
        expect(historical.status).toBe(200);
        expect(historical.body.action.data.executed).toBe(false);
        expect(historical.body.action.text).toContain(
          "not proof of its final alarm state",
        );
        expect(
          (
            await proposeOverHttp(
              { ...operation, days: days.length ? [] : [2] },
              observation,
              key,
              repeatCapability,
            )
          ).status,
        ).toBe(409);
      }
      expect(repeatDigests.size).toBe(3);
      const ownedCapability = "clock.alarms.v1";
      const alarmId = randomUUID();
      const ownedFields = {
        hour: 9,
        minute: 0,
        label: "Eliza alarm fixture",
        timeZone: "UTC",
        days: [2, 3, 4, 5, 6],
      };
      const ownedContext = {
        ...observation,
        alarmsStatus: "available",
        alarmsObservedAt: Date.now(),
        alarmsRevision: 12,
        alarms: [
          {
            id: alarmId,
            ...ownedFields,
            enabled: true,
            nextAt: Date.now() + 60_000,
            scheduleState: "scheduled",
            generation: 1,
            lastOutcome: "",
          },
        ],
      };
      const ownedRequest = (path: string, body?: unknown) =>
        request(path, body, "a", deviceKey, ownedCapability);
      const ownedSet = { type: "clock_alarm", action: "set", ...ownedFields };
      for (const context of [
        undefined,
        { ...ownedContext, alarmsStatus: "stale" },
        { ...ownedContext, alarmsStatus: "unavailable" },
        { ...ownedContext, alarmsRevision: -1 },
        {
          ...ownedContext,
          alarms: [ownedContext.alarms[0], ownedContext.alarms[0]],
        },
      ])
        expect(
          (
            await proposeOverHttp(
              ownedSet,
              context,
              randomUUID(),
              ownedCapability,
            )
          ).status,
        ).toBe(409);
      for (const operation of [
        { ...ownedSet, days: undefined },
        { ...ownedSet, days: [2, 2] },
        { type: "clock_alarm", action: "delete", alarmId: randomUUID() },
        { type: "clock_alarm", action: "dismiss" },
        { type: "clock_alarm", action: "snooze", alarmId, minutes: 61 },
        { type: "clock_alarm", action: "enable", alarmId, enabled: "true" },
        { type: "clock_handoff", action: "show" },
      ])
        expect(
          (
            await proposeOverHttp(
              operation,
              ownedContext,
              randomUUID(),
              ownedCapability,
            )
          ).status,
        ).toBe(409);
      expect(
        (
          await proposeOverHttp(
            ownedSet,
            ownedContext,
            randomUUID(),
            repeatCapability,
          )
        ).status,
      ).toBe(409);
      const fullSnapshot = {
        ...ownedContext,
        alarms: Array.from({ length: 21 }, (_, index) => ({
          ...ownedContext.alarms[0],
          id: randomUUID(),
          label: `Exact label ${index}`,
        })),
      };
      const ownedPlanner = await withDeviceActionTurn(
        runtimeState.runtime,
        { ...credentials, capabilities: [ownedCapability, capability] },
        async () => {
          const message = {
            ...memory,
            content: {
              text: "Remind me to stretch",
              metadata: {
                uiTab: "other metadata retained",
                clientDevice: { installationId: device, context: fullSnapshot },
              },
            },
          };
          const originalMessage = JSON.stringify(message);
          expect(
            stage1ResponseStateProviderNames(runtimeState.runtime, message, [
              "OWNER",
            ]),
          ).toContain("CurrentElizaOwnedAlarmSnapshot");
          const state = await runtimeState.runtime.composeState(
            message,
            ["CurrentElizaOwnedAlarmSnapshot"],
            true,
            true,
          );
          expect(
            runtimeState.runtime.providers.some(
              (provider) => provider.name === "CurrentElizaOwnedAlarmSnapshot",
            ),
          ).toBe(true);
          const context = await createV5MessageContextObject({
            runtime: runtimeState.runtime,
            message,
            state,
            selectedContexts: ["general"],
            includeTools: true,
            userRoles: ["OWNER"],
            preselectedActions: [proposeDeviceAction],
          });
          const name = "CurrentElizaOwnedAlarmSnapshot";
          const source = context.events.find(
            (event) => event.type === "provider" && event.name === name,
          );
          expect(source?.type).toBe("provider");
          const sourceText =
            source?.type === "provider" ? (source.text ?? "") : "";
          const selectedSnapshot = fullSnapshot;
          expect(
            JSON.parse(sourceText.split("CurrentElizaOwnedAlarmSnapshot: ")[1]),
          ).toEqual(selectedSnapshot);
          expect(sourceText).toContain("Exact label 20");
          const routing = projectDiscoverableContext(context, state);
          const requested = readContextRequests(
            { contextRequests: [name] },
            routing.available,
          );
          expect(requested).toEqual([name]);
          const phaseContexts = [routing.context];
          for (const providerPhase of ["planning", "completion"] as const) {
            const phaseContext = await createV5MessageContextObject({
              runtime: runtimeState.runtime,
              message,
              state,
              selectedContexts: ["general"],
              includeTools: false,
              providerPhase,
              userRoles: ["OWNER"],
            });
            phaseContexts.push(
              projectDeferredProviders({
                ...phaseContext,
                metadata: {
                  ...phaseContext.metadata,
                  providerDiscoveryEnabled: true,
                  loadedContextProviders: [],
                },
              }).context,
            );
          }
          for (const projected of phaseContexts) {
            const text = renderContextObject(projected)
              .promptSegments.map((segment) => segment.content)
              .join("\n");
            expect(text).toContain("Full current Eliza alarm records");
            expect(text).not.toContain("Exact label 0");
            expect(text).not.toContain("Exact label 20");
            expect(text).not.toContain("Update replaces all schedule fields");
          }
          const restored = projectDiscoverableContext(
            context,
            state,
            new Set(requested),
          ).context;
          expect(
            restored.events.find(
              (event) => event.type === "provider" && event.name === name,
            ),
          ).toEqual(source);
          const restoredPlanning = projectDeferredProviders({
            ...context,
            metadata: {
              ...context.metadata,
              providerDiscoveryEnabled: true,
              loadedContextProviders: requested,
            },
          }).context;
          expect(
            restoredPlanning.events.find(
              (event) => event.type === "provider" && event.name === name,
            ),
          ).toEqual(source);
          const withoutCapability = await withDeviceActionTurn(
            runtimeState.runtime,
            { ...credentials, capabilities: [capability] },
            async () =>
              runtimeState.runtime.composeState(message, [name], true, true),
          );
          expect(withoutCapability.data.providers?.[name]?.text ?? "").toBe("");
          expect(JSON.stringify(message)).toBe(originalMessage);
          const projectedMessage = context.events.find(
            (event) =>
              event.type === "message" && event.message.id === message.id,
          );
          expect(
            projectedMessage?.type === "message" &&
              projectedMessage.message.content,
          ).toEqual({
            ...message.content,
            metadata: {
              ...message.content.metadata,
              clientDevice: {
                ...message.content.metadata.clientDevice,
                context: { providerReference: name },
              },
            },
          });
          expect(
            renderContextObject(restored)
              .promptSegments.map((segment) => segment.content)
              .join("\n"),
          ).toContain(JSON.stringify(fullSnapshot));
          const fallback = await createV5MessageContextObject({
            runtime: runtimeState.runtime,
            message,
            state: { values: {}, data: {}, text: "" },
            userRoles: ["OWNER"],
          });
          expect(
            renderContextObject(fallback)
              .promptSegments.map((segment) => segment.content)
              .join("\n"),
          ).toContain("Exact label 20");
          return context;
        },
      );
      const ownedTool = ownedPlanner.events.find(
        (event) =>
          event.type === "tool" && event.tool.name === "PROPOSE_DEVICE_ACTION",
      );
      expect(
        ownedTool?.type === "tool" &&
          ownedTool.tool.parameters?.properties?.operation.anyOf.every(
            (branch) => branch.properties?.type.enum?.[0] === "clock_alarm",
          ),
      ).toBe(true);
      const ownedCases = [
        ...[[], [1, 2, 3, 4, 5, 6, 7], [2, 3, 4, 5, 6], [2, 4, 6]].map(
          (days) => ({ operation: { ...ownedSet, days }, status: "scheduled" }),
        ),
        {
          operation: {
            type: "clock_alarm",
            action: "update",
            alarmId,
            ...ownedFields,
          },
          status: "updated",
        },
        {
          operation: { type: "clock_alarm", action: "delete", alarmId },
          status: "deleted",
        },
        {
          operation: {
            type: "clock_alarm",
            action: "enable",
            alarmId,
            enabled: true,
          },
          status: "enabled",
        },
        {
          operation: {
            type: "clock_alarm",
            action: "enable",
            alarmId,
            enabled: false,
          },
          status: "disabled",
        },
        {
          operation: { type: "clock_alarm", action: "dismiss", alarmId },
          status: "dismissed",
        },
        {
          operation: {
            type: "clock_alarm",
            action: "snooze",
            alarmId,
            minutes: 10,
          },
          status: "snoozed",
        },
        { operation: { type: "clock_alarm", action: "show" }, status: "shown" },
      ];
      for (const { operation, status } of ownedCases) {
        const key = randomUUID();
        const currentContext =
          operation.action === "update"
            ? {
                ...ownedContext,
                alarms: [
                  {
                    ...ownedContext.alarms[0],
                    enabled: false,
                    nextAt: null,
                    scheduleState: "disabled",
                  },
                ],
              }
            : ownedContext;
        const proposed = await proposeOverHttp(
          operation,
          currentContext,
          key,
          ownedCapability,
        );
        expect(proposed.status).toBe(200);
        expect(proposed.body.metadata.clientDevice.context).toEqual(
          currentContext,
        );
        // Pending proposals still require the authenticated device decision and
        // claim. These pause flags attest neither a visible dialog nor delivery.
        expect(proposed.body.action.data).toMatchObject({
          state: "pending",
          executed: false,
          approvalRequired: true,
        });
        if (operation.action === "dismiss" || operation.action === "snooze") {
          expect(proposed.body.action.data.awaitingDeviceExecution).toBe(true);
          expect(proposed.body.action.data).not.toHaveProperty(
            "awaitingUserInput",
          );
        } else {
          expect(proposed.body.action.data.awaitingUserInput).toBe(true);
          expect(proposed.body.action.data).not.toHaveProperty(
            "awaitingDeviceExecution",
          );
        }
        expect(proposed.body.action.text).toContain(
          "This tool has performed no device operation.",
        );
        expect(proposed.body.action.data).not.toHaveProperty(
          "requiresConfirmation",
        );
        if (operation.action === "dismiss" || operation.action === "snooze") {
          expect(proposed.body.action.text).toContain(
            "recorded and pending for the phone",
          );
          expect(proposed.body.action.text).toContain(
            "may request manual review",
          );
          expect(proposed.body.action.text).toContain(
            "do not prove a visible approval dialog",
          );
          expect(proposed.body.action.text).toContain(
            "Await an applied native receipt before claiming completion",
          );
        } else {
          expect(proposed.body.action.text).toBe(
            "Durable device proposal state: pending. This tool has performed no device operation.",
          );
        }
        const id = proposed.body.action.data.proposalId;
        const pending = (await ownedRequest("/proposals")).body.proposals.find(
          (item: any) => item.id === id,
        );
        expect(pending.payload.clockContextRevision).toBe(12);
        expect(pending.payload.operation).toEqual(operation);
        expect(
          (
            await ownedRequest(`/proposals/${id}/claim`, {
              digest: pending.digest,
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await clockRequest(`/proposals/${id}/decision`, {
              digest: pending.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(409);
        expect(
          (
            await ownedRequest(`/proposals/${id}/decision`, {
              digest: pending.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(200);
        const claimed = await ownedRequest(`/proposals/${id}/claim`, {
          digest: pending.digest,
        });
        expect(claimed.status).toBe(200);
        expect(
          (
            await ownedRequest(`/proposals/${id}/claim`, {
              digest: pending.digest,
            })
          ).status,
        ).toBe(409);
        const operationId = randomUUID();
        const result = {
          kind: "clock-alarm",
          action: operation.action,
          status,
          ...(operation.action === "show"
            ? {}
            : { alarmId: operation.action === "set" ? operationId : alarmId }),
          ...(["show", "delete"].includes(operation.action)
            ? {}
            : {
                nextAt:
                  status === "disabled" || status === "updated"
                    ? null
                    : Date.now() + 60_000,
              }),
        };
        const receipt = {
          digest: pending.digest,
          attemptId: claimed.body.proposal.execution.attemptId,
          receipt: { outcome: "applied", operationId, result },
        };
        expect(
          (
            await ownedRequest(`/proposals/${id}/receipt`, {
              ...receipt,
              receipt: {
                ...receipt.receipt,
                result: { ...result, status: "opened" },
              },
            })
          ).status,
        ).toBe(409);
        if (operation.action !== "show")
          expect(
            (
              await ownedRequest(`/proposals/${id}/receipt`, {
                ...receipt,
                receipt: {
                  ...receipt.receipt,
                  result: { ...result, alarmId: randomUUID() },
                },
              })
            ).status,
          ).toBe(409);
        if (["scheduled", "enabled", "snoozed"].includes(status))
          expect(
            (
              await ownedRequest(`/proposals/${id}/receipt`, {
                ...receipt,
                receipt: {
                  ...receipt.receipt,
                  result: { ...result, nextAt: null },
                },
              })
            ).status,
          ).toBe(409);
        const recorded = await ownedRequest(
          `/proposals/${id}/receipt`,
          receipt,
        );
        expect(recorded.status).toBe(200);
        expect(recorded.body.proposal.execution.providerReceipt.result).toEqual(
          result,
        );
        const historical = await proposeOverHttp(
          operation,
          undefined,
          key,
          ownedCapability,
        );
        expect(historical.status).toBe(200);
        expect(historical.body.action.data).toMatchObject({
          proposalId: id,
          executed: false,
          result,
        });
        expect(historical.body.action.text).toContain(
          "not a current alarm read",
        );
      }
      console.info(
        "Clock HTTP/PGlite: legacy handoffs plus owned alarm lifecycle, complete snapshots, revision binding, targeted receipts, capability loss and immutable replay PASS",
      );
    }
    {
      const capability = "maps.selected-read.v1";
      const service = new DeviceActionService(runtimeState.runtime);
      const c = { ...credentials, capabilities: [capability] };
      for (const kind of ["map-place", "map-route"] as const) {
        const target = { kind, id: `maps_${randomUUID()}`, revision: "1" };
        const operation = { type: "maps_read_selected", target };
        const observation = {
          view: "maps",
          sensitive: false,
          revision: 1,
          selectedObject: target,
        };
        await expect(
          service.propose(
            credentials,
            operation,
            "maps-no-cap",
            "fixture",
            observation,
          ),
        ).rejects.toThrow();
        await expect(
          service.propose(c, operation, "maps-no-context", "fixture"),
        ).rejects.toThrow();
        await expect(
          service.propose(c, operation, "maps-stale", "fixture", {
            ...observation,
            selectedObject: { ...target, revision: "2" },
          }),
        ).rejects.toThrow();
        mapsActionParameters = {
          operation,
          operationKey: `maps-selected-${kind}`,
          reason: "fixture",
        };
        const transport = await fetch(
          `${origin}/api/maps-observation-fixture`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${sessions.a}`,
              "x-eliza-device-id": device,
              "x-eliza-device-key": deviceKey,
              "x-eliza-device-capabilities": capability,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              text: "Review selected Maps fixture",
              metadata: {
                clientDevice: {
                  context: observation,
                  subjectUserId: ownerB,
                  installationId: "forged-device",
                  enrollmentId: "forged-enrollment",
                },
                uiViewActionNames: ["FORGED_ACTION"],
              },
            }),
          },
        );
        expect(transport.status).toBe(200);
        const transported = (await transport.json()) as {
          action: { data: { proposalId: string } };
          metadata: Record<string, unknown>;
        };
        expect(transported.metadata.clientDevice).toMatchObject({
          context: observation,
        });
        expect(transported.metadata.uiViewActionNames).toBeUndefined();
        const proposed = transported.action;
        const rows = await request(
          "/proposals",
          undefined,
          "a",
          deviceKey,
          capability,
        );
        const item = rows.body.proposals.find(
          (p: any) => p.id === (proposed && proposed.data?.proposalId),
        );
        expect(item.subjectUserId).toBe(ownerA);
        expect(item.payload.installationId).toBe(device);
        expect(item.payload.enrollmentId).not.toBe("forged-enrollment");
        expect(item.state).toBe("pending");
        expect(item.execution).toBeNull();
        const req = (
          suffix: string,
          body?: unknown,
          owner = "a",
          key = deviceKey,
          cap = capability,
        ) => request(`/proposals/${item.id}/${suffix}`, body, owner, key, cap);
        expect(
          (
            await req(
              "decision",
              { digest: item.digest, decision: "approve" },
              "b",
            )
          ).status,
        ).toBe(409);
        expect(
          (
            await req(
              "decision",
              { digest: item.digest, decision: "approve" },
              "a",
              "b".repeat(64),
            )
          ).status,
        ).toBe(409);
        expect(
          (
            await req(
              "decision",
              { digest: item.digest, decision: "approve" },
              "a",
              deviceKey,
              "notes.local-record.v1",
            )
          ).status,
        ).toBe(409);
        expect(
          (await req("decision", { digest: item.digest, decision: "approve" }))
            .status,
        ).toBe(200);
        const claim = await req("claim", { digest: item.digest });
        expect(claim.status).toBe(200);
        expect((await req("claim", { digest: item.digest })).status).toBe(409);
        const result = {
          kind: "maps_read_selected",
          version: 1,
          target,
          fields: {
            kind,
            providerId: "fixture-region",
            providerRevision: "1",
            attribution: "Synthetic region",
            ...(kind === "map-place"
              ? {
                  label: "Approved fixture place",
                  coordinate: { latitude: 43.7384, longitude: 7.4246 },
                }
              : {
                  from: { latitude: 43.7384, longitude: 7.4246 },
                  to: { latitude: 43.739, longitude: 7.4272 },
                  mode: "walk",
                  distanceMeters: 307,
                  durationSeconds: 223,
                  traffic: "none",
                }),
          },
        };
        const receipt = {
          digest: item.digest,
          attemptId: claim.body.proposal.execution.attemptId,
          receipt: {
            outcome: "applied",
            operationId: "maps-fixture-read",
            result,
          },
        };
        expect(
          (
            await req("receipt", {
              ...receipt,
              receipt: {
                ...receipt.receipt,
                result: { ...result, target: { ...target, revision: "2" } },
              },
            })
          ).status,
        ).toBe(409);
        if (kind === "map-route") {
          expect(
            (
              await req("receipt", {
                ...receipt,
                receipt: {
                  outcome: "unknown",
                  operationId: "maps-fixture-read",
                },
              })
            ).body.proposal.state,
          ).toBe("reconciliation_required");
          const resolution = {
            digest: item.digest,
            attemptId: receipt.attemptId,
            resolution: { confirmed: true, ...receipt.receipt },
          };
          expect(
            (
              await req("reconciliation", {
                ...resolution,
                resolution: {
                  ...resolution.resolution,
                  result: { ...result, target: { ...target, revision: "2" } },
                },
              })
            ).status,
          ).toBe(409);
          expect(
            (await req("reconciliation", resolution)).body.proposal.state,
          ).toBe("done");
          expect((await req("reconciliation", resolution)).status).toBe(200);
        } else {
          expect((await req("receipt", receipt)).body.proposal.state).toBe(
            "done",
          );
          expect((await req("receipt", receipt)).status).toBe(200);
        }
        const restored = await request(
          "/proposals",
          undefined,
          "a",
          deviceKey,
          capability,
        );
        expect(
          restored.body.proposals.find((p: any) => p.id === item.id).execution
            .providerReceipt.result,
        ).toEqual(result);
        const recovered = await withDeviceActionTurn(
          runtimeState.runtime,
          c,
          () =>
            proposeDeviceAction.handler(
              runtimeState.runtime,
              {
                ...memory,
                content: {
                  ...memory.content,
                  metadata: {},
                },
              },
              undefined,
              {
                parameters: {
                  operation,
                  operationKey: `maps-selected-${kind}`,
                  reason: "fixture",
                },
              },
            ),
        );
        expect(
          activeCommittedEffectReceipts(
            recovered ? (recovered.effectReceipts ?? []) : [],
          ),
        ).toHaveLength(0);
        if (!recovered) throw new Error("Missing selected Maps observation");
        const falseReadClaim = await evaluate(
          recovered,
          true,
          recovered.effectReceipts?.[0]?.receiptId,
        );
        expect(falseReadClaim.success).toBe(false);
        expect(falseReadClaim.messageToUser).toBeUndefined();
        expect(recovered && recovered.data).toMatchObject({
          proposalId: item.id,
          executed: false,
          result,
        });
        await expect(
          service.propose(
            c,
            { ...operation, target: { ...target, revision: "2" } },
            `maps-selected-${kind}`,
            "fixture",
          ),
        ).rejects.toThrow();
        await expect(
          service.propose(
            credentials,
            operation,
            `maps-selected-${kind}`,
            "fixture",
          ),
        ).rejects.toThrow();
      }
    }
    {
      // Reminder operations share the same real queue and immutable provider receipt path.
      const reminderCredentials = {
        ...credentials,
        capabilities: ["reminders.local-record.v1"],
      };
      const source = { sourceId: "19", sourceRevision: "a".repeat(64) };
      const target = {
        ...source,
        reminderId: "71",
        revision: "b".repeat(64),
        occurrenceId: "occurrence-1",
      };
      const fields = {
        title: "Approved reminder",
        body: "Approved selected Reminder content",
      };
      const reminderService = new DeviceActionService(runtimeState.runtime);
      await expect(
        reminderService.propose(
          credentials,
          { type: "reminder_read_selected", target },
          "reminder-missing-cap",
          "fixture",
        ),
      ).rejects.toThrow();
      for (const kind of [
        "reminder_read_selected",
        "reminder_update",
        "reminder_complete",
        "reminder_snooze",
        "reminder_cancel",
      ] as const) {
        const operation =
          kind === "reminder_update"
            ? { type: kind, target, fields }
            : { type: kind, target };
        const proposed = await reminderService.propose(
          reminderCredentials,
          operation,
          kind,
          "fixture",
        );
        const repeated = await reminderService.propose(
          reminderCredentials,
          operation,
          kind,
          "fixture",
        );
        expect(repeated.id).toBe(proposed.id);
        const item = (await request("/proposals")).body.proposals.find(
          (p: any) => p.id === proposed.id,
        );
        expect(item.state).toBe("pending");
        expect(item.execution).toBeNull();
        expect(
          (
            await request(
              `/proposals/${item.id}/decision`,
              { digest: item.digest, decision: "approve" },
              "b",
            )
          ).status,
        ).toBe(409);
        expect(
          (
            await request(`/proposals/${item.id}/decision`, {
              digest: item.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(200);
        const claimed = await request(`/proposals/${item.id}/claim`, {
          digest: item.digest,
        });
        expect(claimed.status).toBe(200);
        expect(
          (
            await request(`/proposals/${item.id}/claim`, {
              digest: item.digest,
            })
          ).status,
        ).toBe(409);
        const result = {
          version: 1,
          kind,
          sourceId: "19",
          reminderId: "71",
          occurrenceId: "occurrence-1",
          revision:
            kind === "reminder_read_selected"
              ? target.revision
              : "c".repeat(64),
          at: Date.now() + 600000,
          status:
            kind === "reminder_cancel"
              ? "cancelled"
              : kind === "reminder_complete"
                ? "completed"
                : "scheduled",
          ...(kind === "reminder_read_selected" ? { fields } : {}),
        };
        const receipt = {
          digest: item.digest,
          attemptId: claimed.body.proposal.execution.attemptId,
          receipt: {
            outcome: "applied",
            operationId: `native-${kind}`,
            result,
          },
        };
        if (kind === "reminder_complete") {
          for (const status of [
            "permission-denied",
            "scheduling-failed",
            "cancelled",
            "scheduled",
            "posted",
          ]) {
            const invalid = await request(`/proposals/${item.id}/receipt`, {
              ...receipt,
              receipt: {
                ...receipt.receipt,
                result: { ...result, status },
              },
            });
            expect(invalid.status).toBe(409);
            const unchanged = (await request("/proposals")).body.proposals.find(
              (p: any) => p.id === item.id,
            );
            expect(unchanged.state).toBe(claimed.body.proposal.state);
            expect(unchanged.execution.providerReceipt).toEqual(
              claimed.body.proposal.execution.providerReceipt,
            );
          }
        }
        expect(
          (
            await request(`/proposals/${item.id}/receipt`, {
              ...receipt,
              receipt: {
                ...receipt.receipt,
                result: { ...result, sourceId: "other" },
              },
            })
          ).status,
        ).not.toBe(200);
        expect(
          (await request(`/proposals/${item.id}/receipt`, receipt)).body
            .proposal.state,
        ).toBe("done");
        expect(
          (await request(`/proposals/${item.id}/receipt`, receipt)).status,
        ).toBe(200);
        const canonical = (await request("/proposals")).body.proposals.find(
          (p: any) => p.id === item.id,
        );
        expect(canonical.execution.providerReceipt.result).toEqual(result);
        const retrieved = await withDeviceActionTurn(
          runtimeState.runtime,
          reminderCredentials,
          () =>
            proposeDeviceAction.handler(
              runtimeState.runtime,
              memory,
              undefined,
              {
                parameters: {
                  operation,
                  operationKey: kind,
                  reason: "fixture",
                },
              },
            ),
        );
        expect(
          activeCommittedEffectReceipts(
            retrieved ? (retrieved.effectReceipts ?? []) : [],
          ),
        ).toHaveLength(kind.endsWith("_read_selected") ? 0 : 1);
        expect(retrieved && retrieved.data).toMatchObject({
          proposalId: item.id,
          executed: false,
          result,
        });
        expect(
          (await request("/proposals")).body.proposals.filter(
            (p: any) => p.id === item.id,
          ),
        ).toHaveLength(1);
      }
    }
    {
      const cap =
        "calendar.local-event.v1,notes.local-record.v1,reminders.local-record.v2,maps.selected-read.v1,clock.handoff.v1,reminders.create.v1";
      const c = { ...credentials, capabilities: cap.split(",") },
        service = new DeviceActionService(runtimeState.runtime);
      const call = (path: string, body?: unknown) =>
        request(path, body, "a", deviceKey, cap);
      expect(
        (await call("/register", { label: "Creation fixture" })).status,
      ).toBe(200);
      expect(
        (
          await request(
            "/proposals",
            undefined,
            "a",
            deviceKey,
            cap + ",reminders.local-record.v1",
          )
        ).status,
      ).toBe(401);
      expect(
        (
          await request(
            "/proposals",
            undefined,
            "a",
            deviceKey,
            cap + ",invented.capability",
          )
        ).status,
      ).toBe(401);
      for (const mode of ["none", "lead", "repeat", "unknown"]) {
        const dueAt = Date.now() + 7200000,
          alertMinutes = mode === "lead" ? 10 : null;
        const operation = {
          type: "reminder_create",
          fields: {
            title: "Reviewed creation",
            body: "Synthetic body",
            schedule: {
              at: dueAt - (alertMinutes ?? 0) * 60000,
              dueAt,
              alertMinutes,
              recurrence:
                mode === "repeat"
                  ? {
                      rule: "daily",
                      zone: "UTC",
                      date: "2026-10-03",
                      time: "13:00",
                      leadMinutes: 0,
                    }
                  : null,
            },
          },
        };
        await expect(
          service.propose(
            { ...c, capabilities: ["reminders.local-record.v2"] },
            operation,
            "old-" + mode,
            "fixture",
          ),
        ).rejects.toThrow();
        await expect(
          service.propose(
            c,
            { ...operation, extra: true },
            "bad-" + mode,
            "fixture",
          ),
        ).rejects.toThrow();
        const runAction = () =>
          withDeviceActionTurn(runtimeState.runtime, c, () =>
            proposeDeviceAction.handler(
              runtimeState.runtime,
              memory,
              undefined,
              {
                parameters: {
                  operation,
                  operationKey: "create-" + mode,
                  reason: "fixture",
                },
              },
            ),
          );
        const proposed = await runAction();
        expect(proposed && proposed.data).toMatchObject({
          executed: false,
          approvalRequired: true,
        });
        const item = (await call("/proposals")).body.proposals.find(
          (p: any) => p.id === (proposed && proposed.data?.proposalId),
        );
        expect(item.payload.operation).toEqual(operation);
        expect(
          (
            await call(`/proposals/${item.id}/decision`, {
              digest: item.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await request(`/proposals/${item.id}/claim`, {
              digest: item.digest,
            })
          ).status,
        ).toBe(409);
        const claimed = await call(`/proposals/${item.id}/claim`, {
          digest: item.digest,
        });
        expect(claimed.status).toBe(200);
        const operationId = "created-" + mode,
          result = {
            version: 1,
            kind: "reminder_create",
            sourceId: "local-reminders",
            reminderId: operationId,
            occurrenceId: "first-occurrence",
            revision: "c".repeat(64),
            status: alertMinutes === null ? "pending" : "scheduled",
            at: operation.fields.schedule.at,
            dueAt,
            alertMinutes,
            fields: operation.fields,
          };
        const receipt = {
          digest: item.digest,
          attemptId: claimed.body.proposal.execution.attemptId,
          receipt: { outcome: "applied", operationId, result },
        };
        expect(
          (
            await call(`/proposals/${item.id}/receipt`, {
              ...receipt,
              receipt: {
                ...receipt.receipt,
                result: { ...result, reminderId: "wrong" },
              },
            })
          ).status,
        ).toBe(409);
        expect(
          (await request(`/proposals/${item.id}/receipt`, receipt)).status,
        ).toBe(409);
        if (mode === "unknown") {
          expect(
            (
              await call(`/proposals/${item.id}/receipt`, {
                ...receipt,
                receipt: { outcome: "unknown", operationId },
              })
            ).body.proposal.state,
          ).toBe("reconciliation_required");
          const recovery = {
            digest: item.digest,
            attemptId: claimed.body.proposal.execution.attemptId,
            resolution: {
              confirmed: true,
              outcome: "applied",
              operationId,
              result,
            },
          };
          expect(
            (await request(`/proposals/${item.id}/reconciliation`, recovery))
              .status,
          ).toBe(409);
          expect(
            (await call(`/proposals/${item.id}/reconciliation`, recovery)).body
              .proposal.state,
          ).toBe("done");
          expect(
            (await call(`/proposals/${item.id}/reconciliation`, recovery))
              .status,
          ).toBe(200);
        } else {
          expect(
            (await call(`/proposals/${item.id}/receipt`, receipt)).body.proposal
              .state,
          ).toBe("done");
          expect(
            (await call(`/proposals/${item.id}/receipt`, receipt)).status,
          ).toBe(200);
        }
        expect(
          (await call(`/proposals/${item.id}/claim`, { digest: item.digest }))
            .status,
        ).toBe(409);
        expect(
          (await call("/proposals")).body.proposals.find(
            (p: any) => p.id === item.id,
          ).execution.providerReceipt.result,
        ).toEqual(result);
        const historical = await runAction();
        expect(historical && historical.data).toMatchObject({
          executed: false,
          result,
        });
      }
    }
    {
      // Real authenticated HTTP + durable approval queue: timing semantics never
      // downgrade to v1, and an identical receipt replay never claims twice.
      const timingCapabilities =
        "calendar.local-event.v1,notes.local-record.v1,reminders.local-record.v2,maps.selected-read.v1,clock.handoff.v1";
      const timingCredentials = {
        ...credentials,
        capabilities: timingCapabilities.split(","),
      };
      const timingService = new DeviceActionService(runtimeState.runtime);
      const timingRequest = (path: string, body?: unknown) =>
        request(path, body, "a", deviceKey, timingCapabilities);
      const advertised = await timingRequest("/register", {
        label: "Timing fixture",
        workflowProtocol: 1,
      });
      expect(advertised.status).toBe(200);
      expect(advertised.body.capabilities).toEqual(
        expect.arrayContaining([
          "reminders.local-record.v1",
          "reminders.local-record.v2",
        ]),
      );
      expect(
        (
          await request(
            "/proposals",
            undefined,
            "a",
            deviceKey,
            timingCapabilities + ",reminders.local-record.v1",
          )
        ).status,
      ).toBe(401);
      const timingTarget = {
        sourceId: "19",
        sourceRevision: "a".repeat(64),
        reminderId: "timing-task",
        occurrenceId: "timing-occurrence",
        revision: "b".repeat(64),
        timingVersion: 2 as const,
      };
      const dueAt = Date.now() + 3600000;
      for (const scenario of [
        "read-none",
        "update-none",
        "update-early",
        "complete-repeat",
        "reconcile-none",
      ] as const) {
        const alertMinutes = scenario === "update-early" ? 10 : null;
        const schedule = {
          at: dueAt - (alertMinutes ?? 0) * 60000,
          recurrence: null,
          dueAt,
          alertMinutes,
        };
        const fields = {
          title: "Reviewed task",
          body: "Synthetic only",
          schedule,
        };
        const operation =
          scenario.startsWith("update") || scenario === "reconcile-none"
            ? { type: "reminder_update" as const, target: timingTarget, fields }
            : {
                type:
                  scenario === "read-none"
                    ? ("reminder_read_selected" as const)
                    : ("reminder_complete" as const),
                target: timingTarget,
              };
        await expect(
          timingService.propose(
            { ...credentials, capabilities: ["reminders.local-record.v1"] },
            operation,
            scenario,
            "fixture",
          ),
        ).rejects.toThrow();
        const proposed = await timingService.propose(
          timingCredentials,
          operation,
          scenario,
          "fixture",
        );
        const item = (await timingRequest("/proposals")).body.proposals.find(
          (p: any) => p.id === proposed.id,
        );
        expect(item.payload.operation).toEqual(operation);
        expect(
          (
            await timingRequest(`/proposals/${item.id}/decision`, {
              digest: item.digest,
              decision: "approve",
            })
          ).status,
        ).toBe(200);
        expect(
          (
            await request(`/proposals/${item.id}/claim`, {
              digest: item.digest,
            })
          ).status,
        ).toBe(409);
        const claimed = await timingRequest(`/proposals/${item.id}/claim`, {
          digest: item.digest,
        });
        expect(claimed.status).toBe(200);
        expect(
          (
            await timingRequest(`/proposals/${item.id}/claim`, {
              digest: item.digest,
            })
          ).status,
        ).toBe(409);
        const result = {
          version: 1,
          kind: operation.type,
          sourceId: timingTarget.sourceId,
          reminderId: timingTarget.reminderId,
          occurrenceId:
            scenario === "complete-repeat"
              ? "timing-next-occurrence"
              : timingTarget.occurrenceId,
          revision:
            scenario === "read-none" ? timingTarget.revision : "c".repeat(64),
          status: alertMinutes === null ? "pending" : "scheduled",
          at: schedule.at,
          dueAt,
          alertMinutes,
          ...(scenario === "read-none" ? { fields } : {}),
        };
        const receipt = {
          digest: item.digest,
          attemptId: claimed.body.proposal.execution.attemptId,
          receipt: {
            outcome: "applied",
            operationId: `native-${scenario}`,
            result,
          },
        };
        const {
          dueAt: ignoredDue,
          alertMinutes: ignoredAlert,
          ...downgraded
        } = result;
        expect(
          (
            await timingRequest(`/proposals/${item.id}/receipt`, {
              ...receipt,
              receipt: { ...receipt.receipt, result: downgraded },
            })
          ).status,
        ).toBe(409);
        expect(
          (await request(`/proposals/${item.id}/receipt`, receipt)).status,
        ).toBe(409);
        if (scenario === "reconcile-none") {
          const uncertain = await timingRequest(
            `/proposals/${item.id}/receipt`,
            {
              ...receipt,
              receipt: { outcome: "unknown", code: "synthetic_lost_response" },
            },
          );
          expect(uncertain.body.proposal.state).toBe("reconciliation_required");
          const reconciliation = {
            digest: item.digest,
            attemptId: claimed.body.proposal.execution.attemptId,
            resolution: {
              confirmed: true,
              outcome: "applied",
              operationId: `native-${scenario}`,
              result,
            },
          };
          expect(
            (
              await request(
                `/proposals/${item.id}/reconciliation`,
                reconciliation,
              )
            ).status,
          ).toBe(409);
          expect(
            (
              await timingRequest(
                `/proposals/${item.id}/reconciliation`,
                reconciliation,
              )
            ).body.proposal.state,
          ).toBe("done");
          expect(
            (
              await timingRequest(
                `/proposals/${item.id}/reconciliation`,
                reconciliation,
              )
            ).status,
          ).toBe(200);
        } else {
          expect(
            (await timingRequest(`/proposals/${item.id}/receipt`, receipt)).body
              .proposal.state,
          ).toBe("done");
          expect(
            (await timingRequest(`/proposals/${item.id}/receipt`, receipt))
              .status,
          ).toBe(200);
        }
        const canonical = (
          await timingRequest("/proposals")
        ).body.proposals.find((p: any) => p.id === item.id);
        expect(canonical.execution.providerReceipt.result).toEqual(result);
        expect(
          (
            await timingRequest(`/proposals/${item.id}/claim`, {
              digest: item.digest,
            })
          ).status,
        ).toBe(409);
      }
    }
    {
      const operation = {
        type: "reminder_snooze",
        target: {
          sourceId: "19",
          sourceRevision: "a".repeat(64),
          reminderId: "71",
          occurrenceId: "occurrence-1",
          revision: "b".repeat(64),
        },
      };
      const service = new DeviceActionService(runtimeState.runtime);
      const proposed = await service.propose(
        { ...credentials, capabilities: ["reminders.local-record.v1"] },
        operation,
        "reminder-recovery",
        "fixture",
      );
      const item = (await request("/proposals")).body.proposals.find(
        (p: any) => p.id === proposed.id,
      );
      expect(
        (
          await request(`/proposals/${item.id}/decision`, {
            digest: item.digest,
            decision: "approve",
          })
        ).status,
      ).toBe(200);
      const claim = await request(`/proposals/${item.id}/claim`, {
        digest: item.digest,
      });
      expect(claim.status).toBe(200);
      const attemptId = claim.body.proposal.execution.attemptId;
      const unknown = await request(`/proposals/${item.id}/receipt`, {
        digest: item.digest,
        attemptId,
        receipt: {
          outcome: "unknown",
          operationId: "native-recovered-reminder",
        },
      });
      expect(unknown.body.proposal.state).toBe("reconciliation_required");
      const result = {
        version: 1,
        kind: "reminder_snooze",
        sourceId: "19",
        reminderId: "71",
        occurrenceId: "occurrence-1",
        revision: "d".repeat(64),
        status: "scheduled",
        at: 2000000000000,
      };
      const resolution = {
        digest: item.digest,
        attemptId,
        resolution: {
          confirmed: true,
          outcome: "applied",
          operationId: "native-recovered-reminder",
          result,
        },
      };
      expect(
        (await request(`/proposals/${item.id}/reconciliation`, resolution, "b"))
          .status,
      ).toBe(409);
      expect(
        (await request(`/proposals/${item.id}/reconciliation`, resolution)).body
          .proposal.state,
      ).toBe("done");
      expect(
        (await request(`/proposals/${item.id}/reconciliation`, resolution)).body
          .proposal.execution.providerReceipt.result,
      ).toEqual(result);
      expect(
        (await request(`/proposals/${item.id}/claim`, { digest: item.digest }))
          .status,
      ).toBe(409);
    }
    {
      for (const header of [
        "x-eliza-device-id",
        "x-eliza-device-key",
        "x-eliza-device-capabilities",
      ])
        expect(CORS_ALLOWED_HEADERS.toLowerCase().split(", ")).toContain(
          header,
        );
      const discovery = await request("/view-profile");
      expect(discovery).toMatchObject({
        status: 200,
        body: { version: 1, profile: null },
      });
      expect(discovery.body.supportedViews).toContain("workflows");
      expect(
        (await request("/register", { label: "Profile fixture" })).body
          .viewProfileVersion,
      ).toBe(1);
      for (const input of [
        { version: 2, views: ["notes"], expectedRevision: null },
        { version: 1, views: ["notes", "notes"], expectedRevision: null },
        { version: 1, views: ["wallet"], expectedRevision: null },
        {
          version: 1,
          views: ["notes"],
          expectedRevision: null,
          owner: "forged",
        },
        { version: 1, views: ["notes"] },
      ])
        expect((await request("/view-profile", input)).status).toBe(409);
      expect((await request("/view-profile", undefined, "none")).status).toBe(
        401,
      );
      expect(
        (await request("/view-profile", undefined, "a", "wrong-key")).status,
      ).toBe(409);
      const first = (
        await request("/view-profile", {
          version: 1,
          views: ["notes", "workflows"],
          expectedRevision: null,
        })
      ).body.profile;
      const globalParameters = JSON.stringify(proposeDeviceAction.parameters);
      const render = (credential: typeof credentials) =>
        withDeviceActionTurn(runtimeState.runtime, credential, async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return createV5MessageContextObject({
            runtime: runtimeState.runtime,
            message: memory,
            state: { values: {}, data: {}, text: "" },
            includeTools: true,
            selectedContexts: [
              { id: "general", name: "General", description: "Fixture" },
            ] as any,
            preselectedActions: [proposeDeviceAction],
          });
        });
      const contexts = await Promise.all([
        render(credentials),
        render({
          ...credentials,
          subjectUserId: ownerB,
          deviceKey: "b".repeat(64),
        }),
      ]);
      const serialized = contexts.map((context) => JSON.stringify(context));
      expect(serialized[0]).toContain(
        "enabled-view profile allows open_view only for",
      );
      expect(serialized[1]).not.toContain(
        "enabled-view profile allows open_view only for",
      );
      const branch = (context: any) =>
        context.events
          .find(
            (event: any) =>
              event.type === "tool" &&
              event.tool.name === "PROPOSE_DEVICE_ACTION",
          )
          .tool.parameters.properties.operation.anyOf.find(
            (b: any) => b.properties?.type?.enum?.[0] === "open_view",
          );
      expect(branch(contexts[0]).properties.view.enum).toEqual([
        "notes",
        "workflows",
      ]);
      expect(branch(contexts[1]).properties.view.enum).toContain("browser");
      expect(JSON.stringify(proposeDeviceAction.parameters)).toBe(
        globalParameters,
      );

      expect(first).toMatchObject({
        version: 1,
        views: ["notes", "workflows"],
      });
      expect(
        (
          await request("/view-profile", {
            version: 1,
            views: ["workflows", "notes"],
            expectedRevision: first.revision,
          })
        ).body.profile,
      ).toEqual(first);
      expect(
        (
          await request("/view-profile", {
            version: 1,
            views: [],
            expectedRevision: null,
          })
        ).status,
      ).toBe(409);
      expect(
        (await request("/view-profile", undefined, "b")).body.profile,
      ).toBeNull();
      const proposeView = async (view: string) => {
        mapsActionParameters = {
          operation: { type: "open_view", view },
          operationKey: randomUUID(),
          reason: "Explicit fixture request",
        };
        const response = await fetch(`${origin}/api/maps-observation-fixture`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${sessions.a}`,
            "x-eliza-device-id": device,
            "x-eliza-device-key": deviceKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: "Open requested view",
            prompt: "Open requested view",
          }),
        });
        return { status: response.status, body: await response.json() };
      };
      const before = (await request("/proposals")).body.proposals.length;
      const disabled = await proposeView("browser");
      expect(disabled.body.action?.success).not.toBe(true);
      expect((await request("/proposals")).body.proposals).toHaveLength(before);
      await proposeView("notes");
      const pending = (await request("/proposals")).body.proposals.find(
        (p: any) =>
          p.payload?.operation?.view === "notes" &&
          p.payload?.viewProfileRevision === first.revision,
      );
      expect(pending).toBeTruthy();
      expect(
        (
          await request(`/proposals/${pending.id}/decision`, {
            digest: pending.digest,
            decision: "approve",
          })
        ).status,
      ).toBe(200);
      await proposeView("workflows");
      const waiting = (await request("/proposals")).body.proposals.find(
        (p: any) =>
          p.payload?.operation?.view === "workflows" &&
          p.payload?.viewProfileRevision === first.revision,
      );
      expect(waiting).toBeTruthy();
      const next = (
        await request("/view-profile", {
          version: 1,
          views: ["notes"],
          expectedRevision: first.revision,
        })
      ).body.profile;
      expect(next.revision).not.toBe(first.revision);
      expect(
        (
          await request(`/proposals/${pending.id}/claim`, {
            digest: pending.digest,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(`/proposals/${waiting.id}/decision`, {
            digest: waiting.digest,
            decision: "approve",
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await request(`/proposals/${waiting.id}/decision`, {
            digest: waiting.digest,
            decision: "reject",
          })
        ).status,
      ).toBe(200);
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
      await runtimeState.cleanup();
      runtimeState = await createRealTestRuntime({
        characterName: "DeviceApprovalFixture",
        pgliteDir: directory,
        removePgliteDirOnCleanup: false,
      });
      origin = await start();
      expect((await request("/view-profile")).body.profile).toEqual(next);
      await proposeView("notes");
      const current = (await request("/proposals")).body.proposals.find(
        (p: any) => p.payload?.viewProfileRevision === next.revision,
      );
      expect(current).toBeTruthy();
      expect(
        (
          await request(`/proposals/${current.id}/decision`, {
            digest: current.digest,
            decision: "approve",
          })
        ).status,
      ).toBe(200);
      const claimed = await request(`/proposals/${current.id}/claim`, {
        digest: current.digest,
      });
      expect(claimed.status).toBe(200);
      expect(
        (
          await request("/view-profile", {
            version: 1,
            views: [],
            expectedRevision: next.revision,
          })
        ).status,
      ).toBe(200);
      expect(branch(await render(credentials))).toBeUndefined();
      expect(JSON.stringify(proposeDeviceAction.parameters)).toBe(
        globalParameters,
      );
      const receipt = {
        digest: current.digest,
        attemptId: claimed.body.proposal.execution.attemptId,
        receipt: { outcome: "applied", operationId: "opened-view-fixture" },
      };
      expect(
        (await request(`/proposals/${current.id}/receipt`, receipt)).status,
      ).toBe(200);
      expect(
        (await request(`/proposals/${current.id}/receipt`, receipt)).status,
      ).toBe(200);
      expect(
        (
          await request(`/proposals/${current.id}/claim`, {
            digest: current.digest,
          })
        ).status,
      ).toBe(409);
      console.log(
        "Authenticated view-profile HTTP: discovery, conditional persistence, disabled proposal refusal, revision-fenced approve/claim, owner isolation, restart and historical receipt PASS",
      );
    }
    expect((await request("/revoke", {})).status).toBe(200);
    expect((await request("/context")).status).toBe(409);
    expect((await request("/proposals")).status).toBe(409);
    expect(
      (await request("/register", { label: "Reused revoked installation" }))
        .status,
    ).toBe(409);
    await expect(propose()).rejects.toThrow();
  } finally {
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await runtimeState.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

// Complete Core Stage-1, discovery, planner, evaluator and reply-egress path
// with a real durable queue. Only model judgments are offline fixtures.
test("Clock-only enrollment scopes actual planner discovery and preserves pending reply egress", async () => {
  const fixture = await createRealTestRuntime({
    characterName: "ClockScopePipelineFixture",
  });
  const runtime = fixture.runtime;
  const credential = {
    subjectUserId: runtime.agentId,
    installationId: randomUUID(),
    deviceKey: "b".repeat(64),
    capabilities: ["clock.handoff.v1"],
  };
  const service = new DeviceActionService(runtime);
  let navigationServer: Server | undefined;
  const originalPort = process.env.ELIZA_API_PORT;
  try {
    await service.register(credential, "Clock scope fixture");
    runtime.registerAction(proposeDeviceAction);
    runtime.registerAction(viewsAction);
    for (const action of [
      calendarAction,
      ownerDocumentsAction,
      ownerRemindersAction,
    ])
      runtime.registerAction(action);
    registerBuiltinViews(runtime, { indexEmbeddings: false });
    const roomId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      name: "Clock scope",
      agentId: runtime.agentId,
      metadata: { ownership: { ownerId: runtime.agentId } },
    });
    await runtime.createRoom({
      id: roomId,
      worldId,
      name: "Clock scope",
      source: "client_chat",
      type: ChannelType.DM,
    });
    const globalSchema = JSON.stringify(proposeDeviceAction.parameters);
    const pendingText =
      "The Clock proposal is awaiting your approval on the phone.";
    const outputs: unknown[] = [
      stage1Response({
        contexts: ["general"],
        intents: ["Open Clock after my approval"],
        candidateActionNames: ["PROPOSE_DEVICE_ACTION"],
        extra: { replyEffectStatus: "none" },
      }),
      {
        text: "",
        toolCalls: [
          {
            id: "discover-clock",
            name: "DISCOVER_ACTIONS",
            arguments: {
              names: [
                "PROPOSE_DEVICE_ACTION",
                "VIEWS",
                "CALENDAR",
                "OWNER_DOCUMENTS",
                "OWNER_REMINDERS",
              ],
              eliza_turn_scope: "more_work_pending",
            },
          },
        ],
      },
      {
        text: "",
        toolCalls: [
          {
            id: "propose-clock",
            name: "PROPOSE_DEVICE_ACTION",
            arguments: {
              operation: { type: "clock_handoff", action: "show" },
              operationKey: "scope-pending",
              reason: "Open requested Clock view after approval",
              eliza_turn_scope: "final",
            },
          },
        ],
      },
      JSON.stringify({
        thought: "A durable proposal exists; no Clock request was executed.",
        decision: "FINISH",
        success: true,
        requestFullyCovered: false,
        messageToUser: pendingText,
        replyEffectStatus: "non_applied",
      }),
    ];
    const calls: Array<{ type: string; parameters: unknown }> = [];
    const useModel = vi
      .spyOn(runtime, "useModel")
      .mockImplementation(async (type, parameters) => {
        calls.push({ type, parameters });
        if (!outputs.length) throw new Error(`Unexpected model call: ${type}`);
        return outputs.shift() as never;
      });
    const message: Memory = {
      id: randomUUID(),
      roomId,
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      content: {
        text: "Open Clock after my approval.",
        source: "client_chat",
        channelType: ChannelType.DM,
        metadata: {
          uiView: "chat",
          uiTab: "chat",
          uiViewPath: "/chat",
          uiViewCapabilities: [],
          uiViewActionNames: [],
          viewClientId: "fixture-renderer",
          clientDevice: {
            context: {
              sensitive: false,
              revision: 1,
              timeZone: "America/Los_Angeles",
            },
          },
        },
      },
    };
    const pending = await withDeviceActionTurn(runtime, credential, () =>
      runV5MessageRuntimeStage1({
        runtime,
        message,
        state: { values: { availableContexts: "general" }, data: {}, text: "" },
        responseId: randomUUID() as UUID,
      }),
    );
    expect(outputs).toHaveLength(0);
    expect(pending.kind).toBe("planned_reply");
    if (pending.kind === "planned_reply") {
      expect(
        pending.result.responseContent?.text,
        JSON.stringify(pending.result.actionResults),
      ).toBe(pendingText);
      expect(pending.result.requestFulfilled).toBe(false);
      expect(pending.result.responseContent?.transcriptVisibility).not.toBe(
        "internal",
      );
    }
    const proposals = await service.list(credential);
    expect(proposals).toHaveLength(1);
    expect(proposals[0].state).toBe("pending");
    expect(proposals[0].execution).toBeNull();
    const plannerCalls = calls.filter(
      ({ type }) => type === ModelType.ACTION_PLANNER,
    );
    expect(plannerCalls).toHaveLength(2);
    for (const { parameters } of plannerCalls) {
      const tools = (
        parameters as { tools: Array<{ name: string; parameters: any }> }
      ).tools;
      const native = tools.find(({ name }) => name === "PROPOSE_DEVICE_ACTION");
      expect(native).toBeDefined();
      expect(
        native!.parameters.properties.operation.anyOf.every(
          (branch: any) => branch.properties.type.enum[0] === "clock_handoff",
        ),
      ).toBe(true);
      expect(
        native!.parameters.properties.operation.anyOf.some(
          (branch: any) => branch.properties.days,
        ),
      ).toBe(false);
    }
    const reloaded = (
      plannerCalls[1].parameters as { tools: Array<{ name: string }> }
    ).tools;
    expect(reloaded.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "VIEWS",
        "CALENDAR",
        "OWNER_DOCUMENTS",
        "OWNER_REMINDERS",
      ]),
    );
    expect(JSON.stringify(proposeDeviceAction.parameters)).toBe(globalSchema);
    const navigationBodies: Array<Record<string, unknown>> = [];
    navigationServer = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      navigationBodies.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          viewId: "chat",
          completedActionHandoffId: body.completedActionHandoffId,
          completedActionDelivered: true,
        }),
      );
    });
    await new Promise<void>((resolve) =>
      navigationServer!.listen(0, "127.0.0.1", resolve),
    );
    const address = navigationServer.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture port");
    process.env.ELIZA_API_PORT = String(address.port);
    outputs.push(
      stage1Response({
        contexts: ["general"],
        intents: ["Show Home"],
        candidateActionNames: ["VIEWS"],
        extra: { replyEffectStatus: "none" },
      }),
      {
        text: "",
        toolCalls: [
          {
            id: "show-home",
            name: "VIEWS",
            arguments: {
              action: "show",
              view: "home",
              eliza_turn_scope: "final",
            },
          },
        ],
      },
      JSON.stringify({
        decision: "FINISH",
        success: true,
        thought: "The originating renderer acknowledged navigation.",
        messageToUser: "Home is open.",
        replyEffectStatus: "non_applied",
      }),
    );
    const errors = vi.spyOn(runtime, "reportError");
    const navigation = await withDeviceActionTurn(runtime, credential, () =>
      runV5MessageRuntimeStage1({
        runtime,
        message: {
          ...message,
          id: randomUUID(),
          content: {
            ...message.content,
            text: "Go home.",
            metadata: {
              ...message.content.metadata,
              uiView: "notes",
              uiTab: "notes",
              uiViewPath: "/notes",
            },
          },
        },
        state: { values: { availableContexts: "general" }, data: {}, text: "" },
        responseId: randomUUID() as UUID,
      }),
    );
    expect(outputs).toHaveLength(0);
    expect(
      navigationBodies,
      JSON.stringify(
        navigation.kind === "planned_reply"
          ? navigation.result.actionResults
          : navigation.kind,
      ),
    ).toHaveLength(1);
    expect(navigationBodies[0].clientId).toBe("fixture-renderer");
    expect(navigationBodies[0]).not.toHaveProperty("closeChat");
    const navigationWire = calls
      .filter(({ type }) => type === ModelType.ACTION_PLANNER)
      .at(-1)!.parameters as { tools: Array<{ name: string }> };
    expect(navigationWire.tools.map(({ name }) => name)).toContain("VIEWS");
    expect(navigationWire.tools.map(({ name }) => name)).not.toContain(
      "PROPOSE_DEVICE_ACTION",
    );
    expect(
      navigation.kind,
      JSON.stringify(
        errors.mock.calls.map(([where, error]) => ({
          where,
          error: String(error),
        })),
      ),
    ).toBe("planned_reply");
    if (navigation.kind === "planned_reply")
      expect(navigation.result.responseContent?.text).toBe("Home is open.");
    expect((await service.list(credential)).map((item) => item.id)).toEqual(
      proposals.map((item) => item.id),
    );
    useModel.mockRestore();
  } finally {
    if (originalPort === undefined) delete process.env.ELIZA_API_PORT;
    else process.env.ELIZA_API_PORT = originalPort;
    if (navigationServer)
      await new Promise<void>((resolve, reject) =>
        navigationServer!.close((error) => (error ? reject(error) : resolve())),
      );
    closeRuntimeViewRegistry(runtime);
    await fixture.cleanup();
  }
});

test.each([
  { action: "dismiss", scope: "final", verdict: "FINISH" },
  { action: "snooze", scope: "more_work_pending", verdict: "CONTINUE" },
])(
  "owned ringing pipeline settles pending device work once: %j",
  async ({ action, scope, verdict }) => {
    const fixture = await createRealTestRuntime({
      characterName: "PendingDevicePipeline",
      withLLM: false,
    });
    const runtime = fixture.runtime;
    const credential = {
      subjectUserId: runtime.agentId,
      installationId: randomUUID(),
      deviceKey: "c".repeat(64),
      capabilities: ["clock.alarms.v1"],
    };
    const service = new DeviceActionService(runtime);
    const alarmId = randomUUID();
    const pendingText = "Your alarm control request is queued for the phone.";
    const operation =
      action === "snooze"
        ? { type: "clock_alarm", action, alarmId, minutes: 5 }
        : { type: "clock_alarm", action, alarmId };
    const outputs: unknown[] = [
      stage1Response({
        contexts: ["general"],
        intents: ["Control my current alarm"],
        candidateActionNames: ["PROPOSE_DEVICE_ACTION"],
        extra: { replyEffectStatus: "none" },
      }),
      {
        text: "",
        toolCalls: [
          {
            id: "control",
            name: "PROPOSE_DEVICE_ACTION",
            arguments: {
              operation,
              operationKey: "owned-pending-control",
              reason: "Requested ringing control",
              eliza_turn_scope: scope,
            },
          },
        ],
      },
      JSON.stringify({
        decision: verdict,
        success: false,
        requestFullyCovered: false,
        messageToUser: pendingText,
        replyEffectStatus: "non_applied",
        thought:
          "The request is durable but the device has not returned a completion receipt.",
      }),
    ];
    const calls: string[] = [];
    const model = vi
      .spyOn(runtime, "useModel")
      .mockImplementation(async (type) => {
        calls.push(type);
        if (!outputs.length)
          throw Error("Pending device request caused another model call");
        return outputs.shift() as never;
      });
    try {
      await service.register(credential, "Owned ringing pipeline");
      runtime.registerAction(proposeDeviceAction);
      const worldId = randomUUID() as UUID;
      const roomId = randomUUID() as UUID;
      await runtime.createWorld({
        id: worldId,
        name: "Pending device",
        agentId: runtime.agentId,
        metadata: { ownership: { ownerId: runtime.agentId } },
      });
      await runtime.createRoom({
        id: roomId,
        worldId,
        name: "Pending device",
        source: "client_chat",
        type: ChannelType.DM,
      });
      const message: Memory = {
        id: randomUUID(),
        roomId,
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        content: {
          text: "Control my current alarm.",
          source: "client_chat",
          channelType: ChannelType.DM,
          metadata: {
            clientDevice: {
              context: {
                sensitive: false,
                revision: 1,
                timeZone: "UTC",
                alarmsStatus: "available",
                alarmsObservedAt: Date.now(),
                alarmsRevision: 12,
                alarms: [
                  {
                    id: alarmId,
                    hour: 9,
                    minute: 0,
                    label: "Current alarm",
                    timeZone: "UTC",
                    days: [],
                    enabled: true,
                    nextAt: Date.now() + 60000,
                    scheduleState: "scheduled",
                    generation: 1,
                    lastOutcome: "",
                  },
                ],
              },
            },
          },
        },
      };
      const result = await withDeviceActionTurn(runtime, credential, () =>
        runV5MessageRuntimeStage1({
          runtime,
          message,
          state: {
            values: { availableContexts: "general" },
            data: {},
            text: "",
          },
          responseId: randomUUID() as UUID,
        }),
      );
      expect(outputs).toHaveLength(0);
      expect(result.kind).toBe("planned_reply");
      if (result.kind === "planned_reply") {
        expect(result.result.requestFulfilled).toBe(false);
        expect(result.result.responseContent?.text).toBe(pendingText);
        expect(result.result.responseContent?.transcriptVisibility).not.toBe(
          "internal",
        );
      }
      expect(
        calls.filter((type) => type === ModelType.ACTION_PLANNER),
      ).toHaveLength(1);
      const proposals = await service.list(credential);
      expect(proposals).toHaveLength(1);
      expect(proposals[0].state).toBe("pending");
      expect(proposals[0].execution).toBeNull();
    } finally {
      model.mockRestore();
      await fixture.cleanup();
    }
  },
  120000,
);

test("enrolled phone record authority blocks backend discovery and forced writes without affecting counter-requests", async () => {
  const fixture = await createRealTestRuntime({
    characterName: "NativeRecordAuthority",
  });
  const runtime = fixture.runtime;
  const directory = await mkdtemp(join(tmpdir(), "native-note-authority-"));
  const notes = new NotesService(runtime, {
    store: new NotesStore({ filePath: join(directory, "notes.json") }),
  });
  await notes.initialize();
  const originalGet = runtime.getService.bind(runtime);
  const serviceLookup = vi
    .spyOn(runtime, "getService")
    .mockImplementation(((name: string) =>
      name === NOTES_SERVICE_TYPE
        ? notes
        : originalGet(name)) as typeof runtime.getService);
  const credential = {
    subjectUserId: runtime.agentId,
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    capabilities: [
      "notes.local-record.v1",
      "calendar.local-event.v1",
      "reminders.local-record.v2",
    ],
  };
  const service = new DeviceActionService(runtime);
  const message = {
    id: randomUUID(),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: randomUUID(),
    content: {
      text: "Create my phone note",
      metadata: {
        clientDevice: {
          installationId: credential.installationId,
          capabilities: credential.capabilities,
        },
      },
    },
  } as Memory;
  const unrelatedActions = [
    ownerAlarmsAction,
    ownerGoalsAction,
    ownerTodosAction,
    ownerRoutinesAction,
    householdCoordinationAction,
    calendarSourcesAction,
  ];
  const actions = [
    ...(notesPlugin.actions ?? []),
    calendarAction,
    ownerRemindersAction,
    proposeDeviceAction,
    ...unrelatedActions,
  ];
  const discover = () =>
    collectDiscoveryCatalogActions({
      actions,
      message,
      selectedContexts: ["general"],
      userRoles: ["OWNER"],
    }).map((action) => action.name);
  const execute = (content: string, actionMessage: Memory = message) =>
    executePlannedToolCall(
      runtime,
      {
        message: actionMessage,
        activeContexts: ["notes"],
        userRoles: ["OWNER"],
      },
      { name: "NOTES_CREATE", params: { content } },
    );
  try {
    expect(
      await service.register(credential, "Native record owner"),
    ).toMatchObject({ userTextFormatVersion: 1 });
    for (const action of actions) runtime.registerAction(action);
    const outside = discover();
    expect(outside).toContain("NOTES_CREATE");
    expect(outside).toContain("CALENDAR");
    expect(outside).toContain("OWNER_REMINDERS");
    await withDeviceActionTurn(runtime, credential, async () => {
      const catalog = discover();
      expect(catalog).not.toContain("NOTES_CREATE");
      expect(catalog).not.toContain("NOTES_PATCH");
      expect(catalog).not.toContain("CALENDAR");
      expect(catalog).not.toContain("OWNER_REMINDERS");
      expect(catalog).toContain("PROPOSE_DEVICE_ACTION");
      for (const action of unrelatedActions) {
        expect(catalog).toContain(action.name);
        expect(
          await resolveActionGateFailure(runtime, action, {
            message,
            userRoles: ["OWNER"],
            evaluateContexts: false,
          }),
        ).toBeUndefined();
      }
      // The authenticated request scope owns this policy; optional message
      // metadata must never disable it at discovery or the effect boundary.
      for (const actionMessage of [
        { ...message, agentId: undefined },
        { ...message, agentId: randomUUID() },
      ]) {
        expect(
          await execute("Must not bypass native ownership", actionMessage),
        ).toMatchObject({ success: false });
      }
      for (const action of [
        ...(notesPlugin.actions ?? []),
        calendarAction,
        standaloneCalendarAction,
        ownerRemindersAction,
      ]) {
        for (const gateContext of [
          { userRoles: ["OWNER"] as const, activeContexts: ["notes"] as const },
          {
            message: { ...message, agentId: undefined },
            userRoles: ["OWNER"] as const,
            activeContexts: ["notes"] as const,
          },
          {
            message: { ...message, agentId: randomUUID() },
            userRoles: ["OWNER"] as const,
            activeContexts: ["notes"] as const,
          },
        ]) {
          expect(actionGateFailure(action, gateContext)).toContain(
            "authenticated phone owns",
          );
        }
      }
      expect(notes.listNotes()).toHaveLength(0);
      // Plan-step and non-CONTEXT hook execution skip context routing, but
      // must retain native-record authority at their final handler gate.
      for (const action of [
        ...(notesPlugin.actions ?? []),
        calendarAction,
        standaloneCalendarAction,
        ownerRemindersAction,
      ]) {
        expect(
          await resolveActionGateFailure(runtime, action, {
            message,
            userRoles: ["OWNER"],
            evaluateContexts: false,
          }),
        ).toContain("authenticated phone owns");
      }
      expect(
        await execute("Must not reach the server Notes store"),
      ).toMatchObject({ success: false });
      expect(notes.listNotes()).toHaveLength(0);
    });
    // Forged clientDevice metadata is not authority; an ordinary counter-request still writes its real store.
    expect(
      await execute("Ordinary backend note", {
        ...message,
        agentId: undefined,
      }),
    ).toMatchObject({ success: true });
    expect(notes.listNotes()).toHaveLength(1);
    await withDeviceActionTurn(
      runtime,
      { ...credential, capabilities: ["clock.handoff.v1"] },
      async () => {
        expect(discover()).toContain("NOTES_CREATE");
        expect(discover()).toContain("CALENDAR");
        expect(discover()).toContain("OWNER_REMINDERS");
        expect(await execute("Clock-only caller backend note")).toMatchObject({
          success: true,
        });
      },
    );
    let release!: () => void;
    const held = withDeviceActionTurn(runtime, credential, async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      expect(discover()).not.toContain("NOTES_CREATE");
    });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discover()).toContain("NOTES_CREATE");
    expect(await execute("Concurrent non-phone note")).toMatchObject({
      success: true,
    });
    release();
    await held;
    expect(notes.listNotes()).toHaveLength(3);
    await expect(
      withDeviceActionTurn(
        runtime,
        { ...credential, deviceKey: "b".repeat(64) },
        async () => execute("Invalid device"),
      ),
    ).rejects.toThrow();
    expect(notes.listNotes()).toHaveLength(3);
  } finally {
    serviceLookup.mockRestore();
    await fixture.cleanup();
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);

test("executor decodes typed phone operation JSON before validation and preserves authority", async () => {
  const fixture = await createRealTestRuntime({
    characterName: "DeviceOperationJson",
    withLLM: false,
  });
  const runtime = fixture.runtime;
  const credential = {
    subjectUserId: runtime.agentId,
    installationId: randomUUID(),
    deviceKey: "d".repeat(64),
    capabilities: ["notes.local-record.v1"],
  };
  const service = new DeviceActionService(runtime);
  const operation = {
    type: "create_note",
    title: "Agent QA MAPLE-49",
    body: "Bring the blue folder.",
  };
  const encoded =
    '{"type":"create_note","title":"Agent QA MAPLE-49","body":"Bring the blue folder."}';
  const message = {
    id: randomUUID(),
    agentId: runtime.agentId,
    entityId: runtime.agentId,
    roomId: randomUUID(),
    content: { text: "Create my phone note" },
  } as Memory;
  const execute = (value: unknown) =>
    executePlannedToolCall(
      runtime,
      { message, activeContexts: ["general"], userRoles: ["OWNER"] },
      {
        name: "PROPOSE_DEVICE_ACTION",
        params: {
          operation: value,
          operationKey: randomUUID(),
          reason: "Owner requested this note",
        },
      },
    );
  try {
    runtime.registerAction(proposeDeviceAction);
    await service.register(credential, "Typed operation fixture");
    await withDeviceActionTurn(runtime, credential, async () => {
      expect(await execute(encoded)).toMatchObject({
        success: true,
        data: { state: "pending", executed: false, approvalRequired: true },
      });
      const pending = await service.list(credential);
      expect(pending).toHaveLength(1);
      expect(pending[0].payload).toMatchObject({ operation });
      expect(await execute(operation)).toMatchObject({ success: true });
      for (const invalid of [
        '{"type":"create_note",',
        "null",
        "[]",
        "42",
        JSON.stringify(encoded),
        JSON.stringify({ ...operation, unexpected: true }),
        JSON.stringify({ ...operation, body: { text: operation.body } }),
        { ...operation, type: "unregistered_operation" },
        { ...operation, unexpected: true },
      ]) {
        expect(await execute(invalid)).toMatchObject({ success: false });
      }
      expect(await service.list(credential)).toHaveLength(2);
    });
    // A decoded object does not grant a native session or unsupported capabilities.
    expect(await execute(encoded)).toMatchObject({ success: false });
    await withDeviceActionTurn(
      runtime,
      { ...credential, capabilities: ["clock.handoff.v1"] },
      async () => {
        expect(await execute(encoded)).toMatchObject({ success: false });
      },
    );
    await expect(
      withDeviceActionTurn(
        runtime,
        { ...credential, deviceKey: "e".repeat(64) },
        async () => execute(encoded),
      ),
    ).rejects.toThrow();
    expect(await service.list(credential)).toHaveLength(2);
    // JSON-looking text remains literal when the authored parameter accepts strings.
    const mixed = validateToolArgs(
      {
        ...proposeDeviceAction,
        parameters: [
          {
            name: "operation",
            required: true,
            description: "Text or structured value",
            schema: {
              anyOf: [
                { type: "string" },
                { type: "object", additionalProperties: true },
              ],
            },
          },
        ],
      },
      { operation: encoded },
    );
    expect(mixed).toMatchObject({ valid: true, args: { operation: encoded } });
  } finally {
    await fixture.cleanup();
  }
}, 120000);

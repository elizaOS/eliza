import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ActionResult,
  activeCommittedEffectReceipts,
  type Memory,
} from "@elizaos/core";
import { expect, test } from "vitest";
import { handleApprovalRoute } from "../../../packages/agent/src/api/approval-routes.ts";
import { readChatRequestPayload } from "../../../packages/agent/src/api/chat-routes.ts";
import {
  deviceRequestCredential,
  handleDeviceActionRoutes,
  requiresDeviceIdentity,
} from "../../../packages/agent/src/api/device-action-routes.ts";
import { buildUserMessages } from "../../../packages/agent/src/api/server-helpers.ts";
import { createMachineSession } from "../../../packages/app/src/api/auth/sessions.ts";
import { resolveAuthorizedRouteRole } from "../../../packages/app/src/api/auth.ts";
import {
  AuthStore,
  type DrizzleDatabase,
} from "../../../packages/app/src/services/auth-store.ts";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
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
    expect(
      (await request("/register", { label: "Fixture phone" })).status,
    ).toBe(200);
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
      { type: "open_view", view: "notes" },
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
    expect((await request("/revoke", {})).status).toBe(200);
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

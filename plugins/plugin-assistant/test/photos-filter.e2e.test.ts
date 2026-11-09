import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  ChannelType,
  executePlannedToolCall,
  type Memory,
  resolveOwnerEntityIdOrDefault,
  type State,
  type UUID,
} from "@elizaos/core";
import { expect, test, vi } from "vitest";
import { createTestRuntime } from "../../../packages/testing/src/pglite-runtime.ts";
import { createAssistantPlugin } from "../src/index.ts";
import { PgApprovalQueue } from "../src/services/approval/store.ts";
import {
  DeviceActionService,
  deviceProposalDigest,
} from "../src/services/device-actions/service.ts";
import { collectV5PlannerCandidateActions } from "../src/services/message/action-surface.ts";
import { withOwnerDeviceActionTurn } from "./device-owner-turn.ts";

test("Photos Filter discovery gates the real proposal and retains one count-only receipt", async () => {
  const fixture = await createTestRuntime({
    characterName: "PhotosFilterReceipt",
    plugins: [createAssistantPlugin()],
  });
  const runtime = fixture.runtime;
  const service = new DeviceActionService(runtime);
  const capabilitySets = [[], ["photos.library.v1"], ["photos.view.v1"]];
  const credential = {
    subjectUserId: resolveOwnerEntityIdOrDefault(runtime),
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    capabilities: ["photos.library.v1", "photos.view.v1"],
  };
  const message: Memory = {
    id: randomUUID(),
    agentId: runtime.agentId,
    entityId: credential.subjectUserId,
    roomId: randomUUID(),
    content: {
      text: "Filter my Photos to show favorite videos.",
      role: "user",
      source: "client_chat",
      channelType: ChannelType.DM,
    },
  };
  const actionName = "DEVICE_PHOTOS_FILTER";
  const state: State = { values: {}, data: {}, text: "" };
  const discover = () =>
    collectV5PlannerCandidateActions({
      runtime,
      message,
      state,
      candidateActions: [actionName],
      selectedContexts: ["media"],
      userRoles: ["OWNER"],
    });
  const operation = { type: "photos_filter", kind: "video", favorite: true };
  const params = {
    operation,
    operationKey: "requested-photo-filter",
    reason: "Show the requested favorite videos.",
  };
  const submit = (overrides = {}) =>
    executePlannedToolCall(
      runtime,
      { message, state, activeContexts: ["media"], userRoles: ["OWNER"] },
      { name: actionName, params: { ...params, ...overrides } },
    );
  try {
    const worldId = randomUUID() as UUID;
    await runtime.createWorld({
      id: worldId,
      name: "Photos filter fixture",
      agentId: runtime.agentId,
      metadata: { ownership: { ownerId: message.entityId } },
    });
    await runtime.createRoom({
      id: message.roomId,
      worldId,
      name: "Photos filter fixture",
      source: "client_chat",
      type: ChannelType.DM,
    });
    await service.register(credential, "Photos filter fixture");
    expect(
      runtime.actions.filter(({ name }) => name === actionName),
    ).toHaveLength(1);
    expect((await discover()).some(({ name }) => name === actionName)).toBe(
      false,
    );
    for (const caps of capabilitySets) {
      const limited = { ...credential, capabilities: caps };
      await withOwnerDeviceActionTurn(runtime, limited, async () => {
        expect((await discover()).some(({ name }) => name === actionName)).toBe(
          false,
        );
        expect(await submit()).toMatchObject({ success: false });
      });
    }
    await withOwnerDeviceActionTurn(
      runtime,
      credential,
      async () => {
        const retired = await submit();
        await expect(
          service.propose(
            credential,
            operation,
            params.operationKey,
            params.reason,
          ),
        ).rejects.toThrow("Original foreground request ended");
        expect(await service.list(credential)).toHaveLength(0);
        expect(retired).toMatchObject({ success: false });
        expect((await discover()).some(({ name }) => name === actionName)).toBe(
          false,
        );
      },
      { isCurrent: () => false },
    );
    expect(await service.list(credential)).toHaveLength(0);

    let current = true;
    const enqueue = PgApprovalQueue.prototype.enqueueTransactional;
    const retireBeforeCommit = vi.spyOn(
      PgApprovalQueue.prototype,
      "enqueueTransactional",
    );
    retireBeforeCommit.mockImplementationOnce(async function (
      this: PgApprovalQueue,
      ...args
    ) {
      const result = await enqueue.apply(this, args);
      current = false;
      return result;
    });
    try {
      const retired = await withOwnerDeviceActionTurn(
        runtime,
        credential,
        () => submit(),
        {
          isCurrent: () => current,
        },
      );
      expect(retireBeforeCommit).toHaveBeenCalledTimes(1);
      expect(await service.list(credential)).toHaveLength(0);
      expect(retired).toMatchObject({ success: false });
    } finally {
      retireBeforeCommit.mockRestore();
    }

    const proposed = await withOwnerDeviceActionTurn(
      runtime,
      credential,
      async () => {
        expect((await discover()).some(({ name }) => name === actionName)).toBe(
          true,
        );
        expect(
          await submit({
            operation: { type: "photos_open", id: "wrong-operation" },
          }),
        ).toMatchObject({ success: false });
        return submit();
      },
    );
    expect(proposed).toMatchObject({
      success: true,
      data: { state: "pending", executed: false, approvalRequired: true },
    });
    const [proposal] = await service.list(credential);
    expect(proposal).toMatchObject({
      payload: { operation },
      state: "pending",
      execution: null,
    });
    const id = proposal.id;
    const digest = deviceProposalDigest(proposal);
    await expect(service.claim(credential, id, digest)).rejects.toThrow(
      "cannot be claimed",
    );

    const foreign = {
      ...credential,
      installationId: randomUUID(),
      deviceKey: "b".repeat(64),
    };
    await service.register(foreign, "Other Photos fixture");
    expect(await service.list(foreign)).toHaveLength(0);
    await expect(service.decide(foreign, id, digest, true)).rejects.toThrow(
      "binding changed",
    );
    await service.decide(credential, id, digest, true);
    const claim = await service.claim(credential, id, digest);
    assert(claim.execution, "Expected one execution claim");
    const attempt = claim.execution.attemptId;
    const receipt = {
      outcome: "applied",
      operationId: "device-filter-1",
      result: { kind: "photos_filter", shown: 2, more: false },
    };
    await expect(
      service.receipt(credential, id, digest, randomUUID(), receipt),
    ).rejects.toThrow("attempt mismatch");
    await expect(
      service.receipt(credential, id, digest, attempt, {
        ...receipt,
        result: { ...receipt.result, mediaIds: ["not-allowed"] },
      }),
    ).rejects.toThrow("Invalid Photos receipt");
    await expect(
      service.receipt(credential, id, digest, attempt, receipt),
    ).resolves.toMatchObject({
      state: "done",
      execution: { providerReceipt: receipt },
    });
    await expect(
      service.receipt(credential, id, digest, attempt, receipt),
    ).resolves.toMatchObject({
      state: "done",
      execution: { providerReceipt: receipt },
    });
    await expect(
      service.receipt(credential, id, digest, attempt, {
        ...receipt,
        result: { ...receipt.result, shown: 3 },
      }),
    ).rejects.toThrow("Receipt conflicts");
    await expect(service.claim(credential, id, digest)).rejects.toThrow(
      "cannot be claimed",
    );

    const replay = await withOwnerDeviceActionTurn(runtime, credential, () =>
      submit(),
    );
    expect(replay).toMatchObject({
      success: true,
      data: {
        proposalId: id,
        state: "done",
        executed: false,
        result: receipt.result,
      },
    });
    expect(await service.list(credential)).toHaveLength(1);

    for (const outcome of ["applied", "not_applied"] as const) {
      const queued = await withOwnerDeviceActionTurn(runtime, credential, () =>
        submit({ operationKey: `recovered-photo-filter-${outcome}` }),
      );
      expect(queued).toMatchObject({
        success: true,
        data: { state: "pending" },
      });
      const pending = (await service.list(credential)).find(
        ({ state }) => state === "pending",
      );
      assert(pending, "Expected the recovery proposal");
      const binding = deviceProposalDigest(pending);
      await service.decide(credential, pending.id, binding, true);
      const claimed = await service.claim(credential, pending.id, binding);
      assert(claimed.execution, "Expected one execution claim to reconcile");
      const currentAttempt = claimed.execution.attemptId;
      await expect(
        service.receipt(credential, pending.id, binding, currentAttempt, {
          outcome: "unknown",
        }),
      ).resolves.toMatchObject({ state: "reconciliation_required" });
      await expect(
        service.claim(credential, pending.id, binding),
      ).rejects.toThrow("cannot be claimed");
      const reviewed = outcome === "applied" ? receipt : { outcome };
      await expect(
        service.reconcile(credential, pending.id, binding, currentAttempt, {
          ...reviewed,
          confirmed: false,
        }),
      ).rejects.toThrow("Explicit outcome review required");
      await expect(
        service.reconcile(credential, pending.id, binding, currentAttempt, {
          ...reviewed,
          confirmed: true,
        }),
      ).resolves.toMatchObject({
        state: outcome === "applied" ? "done" : "retryable",
        execution: { providerReceipt: reviewed },
      });
      await expect(
        service.claim(credential, pending.id, binding),
      ).rejects.toThrow("cannot be claimed");
    }
  } finally {
    await fixture.cleanup();
  }
});

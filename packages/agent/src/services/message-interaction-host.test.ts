/**
 * Exercises the real host coordinator with core's in-memory atomic store.
 * The harness is deterministic and proves binding denial, expiry, revocation,
 * receipt retention, replay, and exactly-once effect dispatch.
 */

import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUTTON_INTERACTION_PROFILE,
  createConnectorInteractionCapabilityProfile,
  decodeMessageInteractionCallback,
  type IAgentRuntime,
  InMemoryMessageInteractionSessionStore,
  resolveMessageInteractionHost,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { MessageInteractionHostService } from "./message-interaction-host.ts";

const START = Date.parse("2026-08-21T00:00:00.000Z");

const block = {
  kind: "choice" as const,
  id: "approve-1",
  scope: "approval",
  options: [
    { value: "approve", label: "Approve" },
    { value: "deny", label: "Deny" },
  ],
};

const bindings = {
  actorId: "actor-a",
  audience: { kind: "room", id: "room-a" },
  agentId: "agent-a",
  connector: { source: "connector", accountId: "account-a" },
  roomId: "room-a",
  sourceMessageId: "message-a",
};

const authenticatedBindings = {
  actorId: bindings.actorId,
  audience: bindings.audience,
  agentId: bindings.agentId,
  connector: bindings.connector,
  roomId: bindings.roomId,
};

const profile = createConnectorInteractionCapabilityProfile({
  template: BUTTON_INTERACTION_PROFILE,
  source: "connector",
  accountId: "account-a",
  targetKind: "room",
  targetId: "room-a",
});

function runtime(): IAgentRuntime {
  return {
    agentId: "agent-a",
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    redactSecrets: (text: string) => text,
  } as never;
}

function fixture() {
  let now = START;
  const service = new MessageInteractionHostService(runtime(), {
    store: new InMemoryMessageInteractionSessionStore(),
    clock: () => now,
    referenceFactory: () => "0123456789abcdef0123456789abcdef",
    claimTtlMs: 100,
  });
  const execute = vi.fn(
    async ({ idempotencyKey }: { idempotencyKey: string }) => ({
      receiptId: `receipt-${idempotencyKey}`,
      canonicalInboundEventId: `memory-${idempotencyKey}`,
      auditId: `audit-${idempotencyKey}`,
      appStateResult: { taskState: "approved" },
      result: { accepted: true },
    }),
  );
  const unregister = service.registerEffectHandler("approve_operation", {
    execute,
  });
  const prepare = () =>
    service.prepare({
      block,
      profile,
      bindings,
      purpose: "approval",
      authorization: {
        decisionId: "decision-a",
        policyRevision: "policy-7",
        decidedAt: "2026-08-20T23:59:59.000Z",
      },
      effect: { kind: "approve_operation", metadata: { operationId: "op-a" } },
      expiresAt: "2026-08-21T00:10:00.000Z",
    });
  const providerReceipt = (inboundEventId = "provider-event-a") => ({
    source: "connector",
    accountId: "account-a",
    inboundEventId,
    receivedAt: new Date(now).toISOString(),
  });
  return {
    service,
    execute,
    unregister,
    prepare,
    providerReceipt,
    setNow(value: number) {
      now = value;
    },
  };
}

describe("MessageInteractionHostService", () => {
  it("resolves only a structurally complete registered host", () => {
    const service = fixture().service;
    expect(
      resolveMessageInteractionHost({
        getService: () => service,
      } as never),
    ).toBe(service);
    expect(
      resolveMessageInteractionHost({ getService: () => null } as never),
    ).toBeNull();
    expect(() =>
      resolveMessageInteractionHost({ getService: () => ({}) } as never),
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_MESSAGE_INTERACTION_HOST_SERVICE",
      }),
    );
  });

  it("returns only renderer-safe preparation fields", async () => {
    const { prepare } = fixture();
    const prepared = await prepare();

    expect(prepared).toMatchObject({
      block: { kind: "choice", id: "approve-1" },
      delivery: { mode: "native" },
      callbackData: "is1:0123456789abcdef0123456789abcdef",
      expiresAt: "2026-08-21T00:10:00.000Z",
      profileId: profile.profileId,
    });
    expect(prepared).not.toHaveProperty("authorization");
    expect(prepared).not.toHaveProperty("effect");
    expect(prepared).not.toHaveProperty("bindings");
  });

  it("returns a validated hosted URL without retained authority fields", async () => {
    const { service } = fixture();
    const hostedProfile = createConnectorInteractionCapabilityProfile({
      template: {
        ...BUTTON_INTERACTION_PROFILE,
        templateId: "signed-hosted-only-test",
        blocks: {
          ...BUTTON_INTERACTION_PROFILE.blocks,
          choice: {
            ...BUTTON_INTERACTION_PROFILE.blocks.choice,
            modes: ["signed-hosted"],
          },
        },
      },
      source: "connector",
      accountId: "account-a",
      targetKind: "room",
      targetId: "room-a",
    });
    const prepared = await service.prepare({
      block,
      profile: hostedProfile,
      bindings,
      purpose: "approval",
      negotiationContext: { signedHostedUrl: "https://example.test/form/a" },
      authorization: {
        decisionId: "decision-hosted",
        policyRevision: "policy-7",
        decidedAt: "2026-08-20T23:59:59.000Z",
      },
      effect: { kind: "approve_operation" },
      expiresAt: "2026-08-21T00:10:00.000Z",
    });

    expect(prepared).toMatchObject({
      delivery: { mode: "signed-hosted" },
      hostedUrl: "https://example.test/form/a",
    });
    expect(prepared).not.toHaveProperty("bindings");
  });

  it("denies a second actor before executing the retained effect", async () => {
    const { service, execute, prepare, providerReceipt } = fixture();
    const prepared = await prepare();

    await expect(
      service.consume({
        callbackData: prepared.callbackData,
        bindings: { ...authenticatedBindings, actorId: "actor-b" },
        response: { value: "approve" },
        providerReceipt: providerReceipt(),
      }),
    ).resolves.toMatchObject({
      status: "denied",
      code: "MESSAGE_INTERACTION_BINDING_MISMATCH",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("denies expiry and post-render authorization revocation", async () => {
    const expired = fixture();
    const expiredPrepared = await expired.prepare();
    expired.setNow(Date.parse("2026-08-21T00:10:00.000Z"));
    await expect(
      expired.service.consume({
        callbackData: expiredPrepared.callbackData,
        bindings: authenticatedBindings,
        response: { value: "approve" },
        providerReceipt: expired.providerReceipt(),
      }),
    ).resolves.toMatchObject({
      status: "denied",
      code: "MESSAGE_INTERACTION_EXPIRED",
    });

    const revoked = fixture();
    const revokedPrepared = await revoked.prepare();
    const reference = decodeMessageInteractionCallback(
      revokedPrepared.callbackData,
    );
    if (!reference) throw new Error("Expected an opaque callback reference");
    await revoked.service.revoke({
      reference,
      decisionId: "decision-a",
      now: START + 1,
    });
    await expect(
      revoked.service.consume({
        callbackData: revokedPrepared.callbackData,
        bindings: authenticatedBindings,
        response: { value: "approve" },
        providerReceipt: revoked.providerReceipt(),
      }),
    ).resolves.toMatchObject({
      status: "denied",
      code: "MESSAGE_INTERACTION_AUTHORIZATION_REVOKED",
    });
    expect(expired.execute).not.toHaveBeenCalled();
    expect(revoked.execute).not.toHaveBeenCalled();
  });

  it("retains provider, inbound, audit, and app-state proof and replays exactly once", async () => {
    const { service, execute, prepare, providerReceipt } = fixture();
    const prepared = await prepare();
    const request = {
      callbackData: prepared.callbackData,
      bindings: authenticatedBindings,
      response: { value: "approve" },
      providerReceipt: providerReceipt(),
    };

    const first = await service.consume(request);
    expect(first).toMatchObject({
      status: "completed",
      receipt: {
        receiptId: "receipt-provider-event-a",
        idempotencyKey: "provider-event-a",
        canonicalInboundEventId: "memory-provider-event-a",
        providerReceipt: { inboundEventId: "provider-event-a" },
        auditId: "audit-provider-event-a",
        appStateResult: { taskState: "approved" },
        result: { accepted: true },
      },
    });
    await expect(service.consume(request)).resolves.toMatchObject({
      status: "replay",
      receipt: { receiptId: "receipt-provider-event-a" },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("rejects mismatched provider authority and conflicting handlers", async () => {
    const { service, execute, prepare, providerReceipt } = fixture();
    expect(() =>
      service.registerEffectHandler("approve_operation", { execute }),
    ).toThrowError(
      expect.objectContaining({
        code: "MESSAGE_INTERACTION_EFFECT_HANDLER_COLLISION",
      }),
    );
    const prepared = await prepare();
    await expect(
      service.consume({
        callbackData: prepared.callbackData,
        bindings: authenticatedBindings,
        response: { value: "approve" },
        providerReceipt: { ...providerReceipt(), accountId: "account-b" },
      }),
    ).resolves.toMatchObject({
      status: "denied",
      code: "MESSAGE_INTERACTION_PROVIDER_RECEIPT_MISMATCH",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("fails closed without a host effect handler and resumes after the claim lease", async () => {
    const fixtureValue = fixture();
    fixtureValue.unregister();
    const prepared = await fixtureValue.prepare();
    const request = {
      callbackData: prepared.callbackData,
      bindings: authenticatedBindings,
      response: { value: "approve" },
      providerReceipt: fixtureValue.providerReceipt(),
    };

    await expect(fixtureValue.service.consume(request)).resolves.toMatchObject({
      status: "denied",
      code: "MESSAGE_INTERACTION_EFFECT_HANDLER_UNAVAILABLE",
    });
    fixtureValue.setNow(START + 101);
    fixtureValue.service.registerEffectHandler("approve_operation", {
      execute: fixtureValue.execute,
    });
    await expect(
      fixtureValue.service.consume({
        ...request,
        providerReceipt: fixtureValue.providerReceipt(),
      }),
    ).resolves.toMatchObject({ status: "completed" });
    expect(fixtureValue.execute).toHaveBeenCalledOnce();
  });

  it("rejects cross-agent preparation and secret-bearing effect proof", async () => {
    const agentMismatch = fixture();
    await expect(
      agentMismatch.service.prepare({
        block,
        profile,
        bindings: { ...bindings, agentId: "agent-b" },
        purpose: "approval",
        authorization: {
          decisionId: "decision-a",
          policyRevision: "policy-7",
          decidedAt: "2026-08-20T23:59:59.000Z",
        },
        effect: { kind: "approve_operation" },
        expiresAt: "2026-08-21T00:10:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "MESSAGE_INTERACTION_AGENT_MISMATCH" });

    const unsafe = fixture();
    unsafe.unregister();
    unsafe.service.registerEffectHandler("approve_operation", {
      execute: async ({ idempotencyKey }) => ({
        receiptId: `receipt-${idempotencyKey}`,
        canonicalInboundEventId: `memory-${idempotencyKey}`,
        auditId: `audit-${idempotencyKey}`,
        appStateResult: { taskState: "approved" },
        result: { apiToken: "must-not-leak" },
      }),
    });
    const prepared = await unsafe.prepare();
    await expect(
      unsafe.service.consume({
        callbackData: prepared.callbackData,
        bindings: authenticatedBindings,
        response: { value: "approve" },
        providerReceipt: unsafe.providerReceipt(),
      }),
    ).resolves.toMatchObject({
      status: "denied",
      code: "MESSAGE_INTERACTION_SECRET_FORBIDDEN",
    });
  });

  it("starts with the real owner-only file authority registered by the host", async () => {
    const root = await mkdtemp(
      path.join(await realpath(tmpdir()), "eliza-interaction-host-"),
    );
    const previousStateDirectory = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = root;
    try {
      const service = await MessageInteractionHostService.start(runtime());
      service.registerEffectHandler("approve_operation", {
        execute: async ({ idempotencyKey }) => ({
          receiptId: `receipt-${idempotencyKey}`,
          canonicalInboundEventId: `memory-${idempotencyKey}`,
          auditId: `audit-${idempotencyKey}`,
          appStateResult: { taskState: "approved" },
          result: { accepted: true },
        }),
      });
      const prepared = await service.prepare({
        block,
        profile,
        bindings,
        purpose: "approval",
        authorization: {
          decisionId: "decision-a",
          policyRevision: "policy-7",
          decidedAt: new Date(Date.now() - 1_000).toISOString(),
        },
        effect: {
          kind: "approve_operation",
          metadata: { operationId: "op-a" },
        },
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const reference = decodeMessageInteractionCallback(prepared.callbackData);
      if (!reference) throw new Error("Expected an opaque callback reference");
      await expect(service.get(reference)).resolves.toMatchObject({
        bindings: { sourceMessageId: "message-a" },
        consume: { state: "pending" },
      });
      await service.stop();
      const restarted = await MessageInteractionHostService.start(runtime());
      restarted.registerEffectHandler("approve_operation", {
        execute: async ({ idempotencyKey }) => ({
          receiptId: `receipt-${idempotencyKey}`,
          canonicalInboundEventId: `memory-${idempotencyKey}`,
          auditId: `audit-${idempotencyKey}`,
          appStateResult: { taskState: "approved" },
          result: { accepted: true },
        }),
      });
      await expect(
        restarted.consume({
          callbackData: prepared.callbackData,
          bindings: authenticatedBindings,
          response: { value: "approve" },
          providerReceipt: {
            source: "connector",
            accountId: "account-a",
            inboundEventId: "provider-file-event-a",
            receivedAt: new Date().toISOString(),
          },
        }),
      ).resolves.toMatchObject({ status: "completed" });
      const filePath = path.join(
        root,
        "message-interactions",
        "agent-a",
        "message-interaction-sessions.v1.json",
      );
      expect((await stat(filePath)).mode & 0o777).toBe(0o600);
      await restarted.stop();
    } finally {
      if (previousStateDirectory === undefined)
        delete process.env.ELIZA_STATE_DIR;
      else process.env.ELIZA_STATE_DIR = previousStateDirectory;
      await rm(root, { force: true, recursive: true });
    }
  });
});

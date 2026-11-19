/** Real SQL admission/consent and actual message handler; connector delivery is recorded only. */
import { randomUUID } from "node:crypto";
import {
  type ContextObject,
  conversationClientUserMemoryId,
  type Memory,
  type MessageHandlerResult,
  runResponseHandlerEvaluators,
  runWithStreamingContext,
  setTurnActionConstraint,
  type UUID,
} from "@elizaos/core";
import { expect, test, vi } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import {
  requireSendConsent,
  sendConsentDigest,
} from "../src/features/messaging/triage/send-consent.ts";
import { routeMessageHandlerOutput } from "../src/runtime/message-handler.ts";
import {
  bindDeviceRequestedActionPolicy,
  DeviceActionService,
  setDeviceReadReplyContext,
  setDeviceReadReplyConversation,
} from "../src/services/device-actions/service.ts";
import { BUILTIN_RESPONSE_HANDLER_EVALUATORS } from "../src/services/message/stage1-evaluators.ts";
import { withOwnerDeviceActionTurn as ownerTurn } from "./device-owner-turn.ts";

/** Production subjects are auth identities (`gateway:<principal>`), distinct
 * from the mapped owner entity that the conversation messages carry. */
function withOwnerDeviceActionTurn<T>(
  ...[runtime, credential, fn, options]: Parameters<typeof ownerTurn<T>>
): Promise<T> {
  return ownerTurn(runtime, credential, fn, {
    ownerEntityId: credential.subjectUserId.replace(/^gateway:/, "") as UUID,
    ...options,
  });
}

async function setup(localCompose = false) {
  const fixture = await createRealTestRuntime({
    characterName: "GmailEffectAuthority",
    withLLM: false,
  });
  const runtime = fixture.runtime,
    owner = randomUUID(),
    device = new DeviceActionService(runtime);
  const credential = {
    subjectUserId: `gateway:${owner}`,
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    capabilities: [
      "gmail.request-policy.v1",
      ...(localCompose ? ["gmail.local-compose.v1"] : []),
    ],
  };
  await device.register(credential, "Effect authority fixture");
  const turn = async <T>(
    text: string,
    fn: (message: Memory) => Promise<T>,
    options: {
      roomId?: string;
      createdAt?: number;
      current?: () => boolean;
      mode?: "initial-gmail-send-v1" | "review-gmail-send-v1";
    } = {},
  ) => {
    const roomId = options.roomId ?? randomUUID(),
      key = randomUUID(),
      scope = "effect-authority";
    return withOwnerDeviceActionTurn(
      runtime,
      credential,
      async () => {
        const message: Memory = {
          id: conversationClientUserMemoryId(scope, key),
          agentId: runtime.agentId,
          entityId: owner,
          roomId,
          createdAt: Math.max(options.createdAt ?? 0, Date.now()),
          content: {
            text,
            source: "client_chat",
            channelType: "DM",
            chatIdempotency: {
              version: 1,
              scope,
              clientMessageId: key,
              fingerprint: "d".repeat(64),
            },
          },
        };
        setDeviceReadReplyConversation(runtime, randomUUID(), roomId);
        setDeviceReadReplyContext(runtime, message, {} as ContextObject);
        expect(
          bindDeviceRequestedActionPolicy(
            runtime,
            options.mode ?? "initial-gmail-send-v1",
            key,
          ),
        ).toBe(true);
        return runWithStreamingContext({ messageId: message.id }, () =>
          fn(message),
        );
      },
      { isCurrent: options.current ?? (() => true) },
    );
  };
  return { ...fixture, runtime, owner, device, credential, turn };
}

test("an explicit owner email draft survives a terminal Stage 1 misclassification", async () => {
  const f = await setup(true);
  const drafts = [
    "Draft an email to myself with subject Alpha draft lifecycle review and body I have the tripod plate for tomorrow. Do not send it.",
    "Could you prepare an email draft to the crew saying hello?",
  ];
  const otherRequests = [
    "Show me the latest email draft.",
    "Don't draft an email to me.",
    'Explain the sentence "Draft an email to me."',
    "Draft an email to me if the meeting moves.",
    "If the meeting moves, draft an email to me.",
    "Draft an email to me and send it.",
    "Draft an email reply to the latest message.",
  ];
  try {
    for (const text of [...drafts, ...otherRequests]) {
      await f.turn(text, async (message) => {
        const stageOne: MessageHandlerResult = {
          processMessage: "RESPOND",
          thought: "",
          plan: {
            contexts: ["simple"],
            intents: [],
            replyEffectStatus: "non_applied",
            reply: "Let me set that up.",
          },
        };
        await runResponseHandlerEvaluators({
          runtime: f.runtime,
          message,
          state: { text: "", values: {}, data: {} },
          messageHandler: stageOne,
          availableContexts: f.runtime.contexts.list(),
          userRoles: ["OWNER"],
          evaluators: BUILTIN_RESPONSE_HANDLER_EVALUATORS.filter(
            ({ name }) => name === "core.direct_registered_capability_request",
          ),
        });
        if (!drafts.includes(text)) {
          expect(stageOne.plan.candidateActions).toBeUndefined();
          expect(stageOne.plan.reply).toBe("Let me set that up.");
          return;
        }
        expect(routeMessageHandlerOutput(stageOne).type).toBe(
          "planning_needed",
        );
        expect(stageOne.plan.candidateActions).toEqual([
          "MESSAGE_DRAFT_FOLLOWUP",
        ]);
        expect(stageOne.plan.reply).toBeUndefined();
        if (text !== drafts[0]) return;

        const action = f.runtime.actions.find(
          ({ name }) => name === stageOne.plan.candidateActions?.[0],
        );
        const stored = vi
          .spyOn(f.runtime, "getMemoryById")
          .mockResolvedValue(message);
        try {
          const result = await action?.handler(f.runtime, message, undefined, {
            parameters: {
              source: "gmail",
              to: ["self"],
              subject: "Alpha draft lifecycle review",
              body: "I have the tripod plate for tomorrow.",
            },
          });
          expect(result).toMatchObject({
            success: true,
            values: {
              mode: "local-compose",
              emailDraft: {
                requestMessageId: message.id,
                to: ["self"],
                subject: "Alpha draft lifecycle review",
                body: "I have the tripod plate for tomorrow.",
              },
            },
          });
          expect(
            await f.runtime.getCache(
              `message-consent:${message.entityId}:${message.roomId}`,
            ),
          ).toBeFalsy();
        } finally {
          stored.mockRestore();
        }
      });
    }
  } finally {
    await f.cleanup();
  }
});

test("the owner phone can request a local Gmail draft without a send broker or an armed confirmation", async () => {
  const f = await setup(true);
  try {
    await f.turn("Draft a new email for tomorrow's shoot", async (message) => {
      const stored = vi
        .spyOn(f.runtime, "getMemoryById")
        .mockResolvedValue(message);
      try {
        const { sendDraftAction } = await import(
          "../src/features/messaging/triage/actions/sendDraft.ts"
        );
        const result = await sendDraftAction.handler(
          f.runtime,
          message,
          undefined,
          {
            parameters: {
              source: "gmail",
              to: ["crew@example.invalid"],
              subject: "Tomorrow's shoot",
              body: "Please bring the tripod.",
            },
          },
        );
        expect(result).toMatchObject({
          success: true,
          turnComplete: true,
          values: {
            mode: "local-compose",
            targetId: "inbox",
            emailDraft: {
              requestMessageId: message.id,
              to: ["crew@example.invalid"],
              subject: "Tomorrow's shoot",
              body: "Please bring the tripod.",
            },
          },
        });
        const { messageAction } = await import(
          "../src/features/advanced-capabilities/actions/message.ts"
        );
        const direct = {
          parameters: {
            action: "send",
            platform: "email",
            recipient: "crew@example.invalid",
            subject: "Tomorrow's shoot",
            message: "Please bring the tripod.",
          },
        };
        expect(
          await messageAction.validate(f.runtime, message, undefined, direct),
        ).toBe(true);
        const routed = await messageAction.handler(
          f.runtime,
          message,
          undefined,
          direct,
        );
        expect(routed).toMatchObject({
          success: true,
          values: {
            mode: "local-compose",
            emailDraft: {
              requestMessageId: message.id,
              to: ["crew@example.invalid"],
              subject: "Tomorrow's shoot",
              body: "Please bring the tripod.",
            },
          },
          data: { actionName: "MESSAGE" },
        });
        const scoped = await messageAction.handler(
          f.runtime,
          message,
          undefined,
          { parameters: { ...direct.parameters, accountId: "other-account" } },
        );
        expect(scoped).toMatchObject({ success: false });
        expect(scoped).not.toHaveProperty("values.emailDraft");
        expect(
          await f.runtime.getCache(
            `message-consent:${message.entityId}:${message.roomId}`,
          ),
        ).toBeFalsy();
        await expect(
          sendDraftAction.handler(
            f.runtime,
            { ...message, entityId: randomUUID() },
            undefined,
            {
              parameters: {
                source: "gmail",
                to: ["crew@example.invalid"],
                subject: "Tomorrow's shoot",
                body: "Please bring the tripod.",
              },
            },
          ),
        ).rejects.toThrow("Reopen this email request");
      } finally {
        stored.mockRestore();
      }
    });
  } finally {
    await f.cleanup();
  }
});

const digest = sendConsentDigest({
  source: "gmail",
  to: "qa@example.invalid",
  body: "Exact body",
});
const consent = (
  runtime: Parameters<typeof requireSendConsent>[0],
  message: Memory,
  value = digest,
) =>
  requireSendConsent(runtime, message, value, {
    source: "gmail",
    requestMessageId: message.id,
  });

test("generic direct preference and forged exact-key allows cannot authorize a read-only request", async () => {
  const f = await setup();
  try {
    for (const forged of [false, true])
      await f.turn(
        "Read my latest email. Do not send or reply to anything.",
        async (message) => {
          if (forged)
            setTurnActionConstraint({
              messageId: message.id ?? "",
              roomId: message.roomId,
              actorId: message.entityId,
              action: "MESSAGE",
              operations: [`gmail-send:${digest}`],
              disposition: "allow",
              reason: "Model/VIEWS says send",
            });
          expect(await consent(f.runtime, message)).toBe("pending");
        },
      );
  } finally {
    await f.cleanup();
  }
});

test("exact later affirmative approval sends only the unchanged reviewed digest once", async () => {
  const f = await setup();
  try {
    let roomId = "",
      time = 0;
    await f.turn("Send the exact QA email", async (message) => {
      roomId = message.roomId;
      time = message.createdAt ?? 0;
      expect(await consent(f.runtime, message)).toBe("pending");
    });
    await f.turn(
      "Yes",
      async (message) => {
        expect(await consent(f.runtime, message)).toBe("confirmed");
        expect(await consent(f.runtime, message)).toBe("cancelled");
      },
      { roomId, createdAt: time + 1 },
    );
  } finally {
    await f.cleanup();
  }
});

test("changed recipient/body, foreign actor or room cannot consume the reviewed send", async () => {
  const f = await setup();
  try {
    let roomId = "",
      time = 0;
    await f.turn("Review QA email", async (message) => {
      roomId = message.roomId;
      time = message.createdAt ?? 0;
      expect(await consent(f.runtime, message)).toBe("pending");
    });
    await f.turn(
      "Yes",
      async (message) => {
        expect(
          await consent(f.runtime, { ...message, entityId: randomUUID() }),
        ).toBe("cancelled");
        expect(
          await consent(f.runtime, { ...message, roomId: randomUUID() }),
        ).toBe("cancelled");
        expect(
          await consent(
            f.runtime,
            message,
            sendConsentDigest({
              source: "gmail",
              to: "different@example.invalid",
              body: "Changed",
            }),
          ),
        ).toBe("pending");
      },
      { roomId, createdAt: time + 1 },
    );
  } finally {
    await f.cleanup();
  }
});

test("ask-first stays review and a current explicit deny takes priority over forged allow", async () => {
  const f = await setup();
  try {
    await f.turn(
      "Send QA",
      async (message) => {
        expect(await consent(f.runtime, message)).toBe("pending");
      },
      { mode: "review-gmail-send-v1" },
    );
    await f.turn("Read only", async (message) => {
      setTurnActionConstraint({
        messageId: message.id ?? "",
        roomId: message.roomId,
        actorId: message.entityId,
        action: "MESSAGE",
        operations: [`gmail-send:${digest}`],
        disposition: "deny",
        reason: "No email send requested",
      });
      expect(await consent(f.runtime, message)).toBe("cancelled");
    });
  } finally {
    await f.cleanup();
  }
});

test("cancelled and retired scopes cannot acquire send consent", async () => {
  const f = await setup();
  try {
    let current = true;
    await f.turn(
      "Send QA",
      async (message) => {
        current = false;
        expect(await consent(f.runtime, message)).toBe("cancelled");
      },
      { current: () => current },
    );
    let late!: () => Promise<unknown>;
    await f.turn("Read only", async (message) => {
      late = () => consent(f.runtime, message);
    });
    // No active authenticated scope can grant initial authority; a call without it only previews.
    expect(await late()).toBe("pending");
  } finally {
    await f.cleanup();
  }
});

test("HTTP parser consumes preference outside model metadata and still requires authenticated device scope", async () => {
  const f = await setup();
  try {
    const { readChatRequestPayload } = await import(
      "../../../packages/agent/src/api/chat-routes.ts"
    );
    const body = {
      text: "Read only",
      clientMessageId: randomUUID(),
      requestedActionPolicy: "initial-gmail-send-v1",
      metadata: { requestedEffect: { action: "send", confirmed: true } },
    };
    const errors: number[] = [];
    const helpers = {
      runtime: f.runtime,
      readJsonBody: async () => body,
      error: (_res: unknown, _message: string, status = 400) =>
        errors.push(status),
    };
    expect(
      await readChatRequestPayload(
        { headers: {} } as never,
        {} as never,
        helpers as never,
      ),
    ).toBeNull();
    expect(errors).toEqual([403]);
  } finally {
    await f.cleanup();
  }
});

test("actual MESSAGE handler refuses automatic send for read-only intent and exact later approval delivers once", async () => {
  const f = await setup();
  const { BaseMessageAdapter } = await import(
    "../src/features/messaging/triage/adapters/base.ts"
  );
  const { getDefaultTriageService } = await import(
    "../src/features/messaging/triage/triage-service.ts"
  );
  const { sendDraftAction } = await import(
    "../src/features/messaging/triage/actions/sendDraft.ts"
  );
  let deliveries = 0,
    roomId = "",
    time = 0,
    draftId = "";
  class Transport extends BaseMessageAdapter {
    readonly source = "gmail" as const;
    isAvailable() {
      return true;
    }
    capabilities() {
      return { ...super.capabilities(), send: { new: true, reply: true } };
    }
    protected async createDraftImpl() {
      return { draftId: randomUUID(), preview: "Exact QA body" };
    }
    protected async sendDraftImpl() {
      deliveries++;
      return { externalId: "recorded-only" };
    }
  }
  getDefaultTriageService().register(new Transport());
  try {
    await f.turn(
      "Read my latest email. Do not send or reply to anything.",
      async (message) => {
        roomId = message.roomId;
        time = message.createdAt ?? 0;
        const result = await sendDraftAction.handler(
          f.runtime,
          message,
          undefined,
          {
            parameters: {
              source: "gmail",
              to: ["qa@example.invalid"],
              subject: "QA",
              body: "Exact QA body",
              confirmed: true,
            },
          },
        );
        expect(result).toMatchObject({ data: { requiresConfirmation: true } });
        expect(deliveries).toBe(0);
        draftId = String(result?.data?.draftId ?? "");
        expect(draftId).not.toBe("");
      },
    );
    await f.turn(
      "Yes",
      async (message) => {
        const result = await sendDraftAction.handler(
          f.runtime,
          message,
          undefined,
          { parameters: { draftId } },
        );
        expect(result).toMatchObject({ success: true, text: "Sent it." });
        expect(deliveries).toBe(1);
        await sendDraftAction.handler(f.runtime, message, undefined, {
          parameters: { draftId },
        });
        expect(deliveries).toBe(1);
      },
      { roomId, createdAt: time + 1 },
    );
  } finally {
    await f.cleanup();
  }
});

test("revoked enrollment cannot authorize or consume a reviewed send", async () => {
  const f = await setup();
  try {
    await f.turn("Read only", async (message) => {
      await f.device.revoke(f.credential);
      await expect(consent(f.runtime, message)).rejects.toThrow();
    });
  } finally {
    await f.cleanup();
  }
});

test("the final Gmail reauthorization cannot send an edited or deleted draft", async () => {
  const { BaseMessageAdapter } = await import(
    "../src/features/messaging/triage/adapters/base.ts"
  );
  const { TriageService } = await import(
    "../src/features/messaging/triage/triage-service.ts"
  );
  const { MessageRefStore } = await import(
    "../src/features/messaging/triage/message-ref-store.ts"
  );
  const { draftConsentDigest } = await import(
    "../src/features/messaging/triage/send-consent.ts"
  );
  const fixture = await createRealTestRuntime({
    characterName: "GmailFinalDigest",
    withLLM: false,
  });
  const runtime = fixture.runtime,
    owner = randomUUID();
  const credential = {
    subjectUserId: `gateway:${owner}`,
    installationId: randomUUID(),
    deviceKey: "d".repeat(64),
    capabilities: ["gmail.request-policy.v1"],
  };
  const outcomes: Array<{ mutation: string; sent: number; error?: string }> =
    [];
  try {
    await new DeviceActionService(runtime).register(
      credential,
      "Final digest fixture",
    );
    for (const mutation of ["edit", "delete", "unchanged", "adapter-edit"]) {
      const store = new MessageRefStore(),
        service = new TriageService(store);
      let sent = 0;
      let pauseAdapterAuthorization: (() => Promise<void>) | undefined;
      class Transport extends BaseMessageAdapter {
        readonly source = "gmail" as const;
        isAvailable() {
          return true;
        }
        async authorizeSend() {
          await pauseAdapterAuthorization?.();
        }
        protected async createDraftImpl() {
          return { draftId: randomUUID(), preview: "Exact body" };
        }
        protected async sendDraftImpl() {
          sent++;
          return { externalId: "accepted" };
        }
      }
      service.register(new Transport());
      await withOwnerDeviceActionTurn(runtime, credential, async () => {
        const roomId = randomUUID(),
          key = randomUUID(),
          scope = "final-digest";
        const message: Memory = {
          id: conversationClientUserMemoryId(scope, key),
          agentId: runtime.agentId,
          entityId: owner,
          roomId,
          createdAt: Date.now(),
          content: {
            text: "Send exact body",
            chatIdempotency: {
              version: 1,
              scope,
              clientMessageId: key,
              fingerprint: "e".repeat(64),
            },
          },
        };
        setDeviceReadReplyConversation(runtime, randomUUID(), roomId);
        setDeviceReadReplyContext(runtime, message, {} as ContextObject);
        bindDeviceRequestedActionPolicy(runtime, "initial-gmail-send-v1", key);
        const draft = await service.draftFollowup(runtime, {
          requester: message,
          source: "gmail",
          to: [{ identifier: "qa@example.invalid" }],
          body: "Exact body",
        });
        const digest = draftConsentDigest(draft);
        expect(
          await requireSendConsent(runtime, message, digest, {
            source: "gmail",
            requestMessageId: message.id,
            draftId: draft.draftId,
          }),
        ).toBe("pending");
        let entered!: () => void, release!: () => void;
        const reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const real = DeviceActionService.prototype.viewProfile;
        if (mutation === "adapter-edit")
          pauseAdapterAuthorization = async () => {
            entered();
            await gate;
          };
        const spy =
          mutation === "adapter-edit"
            ? undefined
            : vi
                .spyOn(DeviceActionService.prototype, "viewProfile")
                .mockImplementation(async function (
                  this: DeviceActionService,
                  value,
                ) {
                  const profile = await real.call(this, value);
                  entered();
                  await gate;
                  return profile;
                });
        try {
          const pending = service
            .sendDraft(runtime, draft.draftId, digest, message)
            .then(
              () => undefined,
              (error) => error,
            );
          await reached;
          if (mutation === "edit")
            store.saveDraft(
              { ...draft, body: "Changed during authorization" },
              runtime.agentId,
            );
          if (mutation === "adapter-edit") {
            const current = store.getDraft(draft.draftId, runtime.agentId);
            if (!current) throw new Error("Missing fixture draft");
            current.body = "Changed in place during adapter authorization";
          }
          if (mutation === "delete") store.clear();
          release();
          const error = await pending;
          outcomes.push({
            mutation,
            sent,
            ...(error ? { error: error.code } : {}),
          });
        } finally {
          release();
          spy?.mockRestore();
        }
      });
    }
    expect(outcomes).toEqual([
      {
        mutation: "edit",
        sent: 0,
        error: "MESSAGE_DRAFT_CONSENT_DIGEST_MISMATCH",
      },
      {
        mutation: "delete",
        sent: 0,
        error: "MESSAGE_DRAFT_CONSENT_DIGEST_MISMATCH",
      },
      { mutation: "unchanged", sent: 1 },
      {
        mutation: "adapter-edit",
        sent: 0,
        error: "MESSAGE_DRAFT_CONSENT_DIGEST_MISMATCH",
      },
    ]);
  } finally {
    await fixture.cleanup();
  }
});

test("copied metadata, stale or replaced context and other connectors retain review", async () => {
  const fixture = await createRealTestRuntime({
    characterName: "GmailPolicyRefusals",
    withLLM: false,
  });
  const runtime = fixture.runtime,
    owner = randomUUID(),
    service = new DeviceActionService(runtime),
    credential = {
      subjectUserId: `gateway:${owner}`,
      installationId: randomUUID(),
      deviceKey: "f".repeat(64),
      capabilities: ["gmail.request-policy.v1"],
    };
  try {
    await service.register(credential, "Gmail refusal fixture");
    expect(
      bindDeviceRequestedActionPolicy(
        runtime,
        "initial-gmail-send-v1",
        randomUUID(),
      ),
    ).toBe(false);
    for (const mode of [
      "metadata-only",
      "wrong-id",
      "wrong-room",
      "wrong-actor",
      "wrong-agent",
      "changed-text",
      "stale",
      "cancelled",
      "other-source",
      "no-conversation",
      "malformed-cache",
    ] as const) {
      let current = true;
      await withOwnerDeviceActionTurn(
        runtime,
        credential,
        async () => {
          const roomId = randomUUID(),
            key = randomUUID(),
            scope = "gmail-negative";
          const original: Memory = {
            id: conversationClientUserMemoryId(scope, key),
            agentId: runtime.agentId,
            entityId: owner,
            roomId,
            createdAt: Date.now(),
            content: {
              text: "Send QA",
              metadata: {
                agentActionMode: "direct-request-v1",
                requestedActionPolicy: "initial-gmail-send-v1",
              },
              chatIdempotency: {
                version: 1,
                scope,
                clientMessageId: key,
                fingerprint: "b".repeat(64),
              },
            },
          };
          if (mode !== "no-conversation")
            setDeviceReadReplyConversation(runtime, randomUUID(), roomId);
          setDeviceReadReplyContext(runtime, original, {} as ContextObject);
          if (mode !== "metadata-only")
            expect(
              bindDeviceRequestedActionPolicy(
                runtime,
                "initial-gmail-send-v1",
                key,
              ),
            ).toBe(true);
          const submitted = structuredClone(original);
          if (mode === "wrong-id") submitted.id = randomUUID();
          if (mode === "wrong-room") submitted.roomId = randomUUID();
          if (mode === "wrong-actor") submitted.entityId = randomUUID();
          if (mode === "wrong-agent") submitted.agentId = randomUUID();
          if (mode === "changed-text")
            submitted.content.text = "Different request";
          if (mode === "stale") submitted.createdAt = Date.now() - 10000;
          if (mode === "cancelled") current = false;
          if (mode === "malformed-cache")
            await runtime.setCache(`message-consent:${owner}:${roomId}`, {
              malformed: true,
            });
          expect(
            await requireSendConsent(
              runtime,
              submitted,
              sendConsentDigest({ mode }),
              {
                source: mode === "other-source" ? "telegram" : "gmail",
                requestMessageId: submitted.id,
              },
            ),
            mode,
          ).toBe(
            mode === "metadata-only" || mode === "other-source"
              ? "pending"
              : "cancelled",
          );
        },
        { isCurrent: () => current },
      );
    }
    await expect(
      withOwnerDeviceActionTurn(
        runtime,
        { ...credential, deviceKey: "0".repeat(64) },
        async () => {},
      ),
    ).rejects.toThrow();
  } finally {
    await fixture.cleanup();
  }
});

test("the HTTP payload command requires an authenticated foreground scope and never enters model metadata", async () => {
  const { readChatRequestPayload } = await import(
    "../../../packages/agent/src/api/chat-routes.ts"
  );
  const fixture = await createRealTestRuntime({
    characterName: "GmailPolicyPayload",
    withLLM: false,
  });
  const runtime = fixture.runtime,
    owner = randomUUID(),
    service = new DeviceActionService(runtime),
    credential = {
      subjectUserId: `gateway:${owner}`,
      installationId: randomUUID(),
      deviceKey: "b".repeat(64),
      capabilities: ["gmail.request-policy.v1"],
    },
    errors: number[] = [];
  const key = randomUUID(),
    body = {
      text: "Send QA",
      clientMessageId: key,
      requestedActionPolicy: "initial-gmail-send-v1",
    };
  const parse = (input: Record<string, unknown>) =>
    readChatRequestPayload({ headers: {} } as never, {} as never, {
      runtime,
      readJsonBody: async () => input as never,
      error: (_res, _message, status) => {
        errors.push(status ?? 400);
      },
    });
  try {
    await service.register(credential, "Payload fixture");
    expect(await parse(body)).toBeNull();
    expect(errors.at(-1)).toBe(403);
    await withOwnerDeviceActionTurn(
      runtime,
      { ...credential, capabilities: [] },
      async () => {
        expect(await parse(body)).toBeNull();
        expect(errors.at(-1)).toBe(403);
      },
    );
    await withOwnerDeviceActionTurn(runtime, credential, async () => {
      const parsed = await parse(body);
      expect(parsed?.prompt).toBe("Send QA");
      expect(parsed?.metadata?.requestedActionPolicy).toBeUndefined();
      const roomId = randomUUID(),
        scope = "http-policy";
      const message: Memory = {
        id: conversationClientUserMemoryId(scope, key),
        agentId: runtime.agentId,
        entityId: owner,
        roomId,
        createdAt: Date.now(),
        content: {
          text: "Send QA",
          chatIdempotency: {
            version: 1,
            scope,
            clientMessageId: key,
            fingerprint: "d".repeat(64),
          },
        },
      };
      setDeviceReadReplyConversation(runtime, randomUUID(), roomId);
      setDeviceReadReplyContext(runtime, message, {} as ContextObject);
      expect(
        await requireSendConsent(
          runtime,
          message,
          sendConsentDigest({ http: "bound" }),
          { source: "gmail", requestMessageId: message.id },
        ),
      ).toBe("pending");
    });
    await withOwnerDeviceActionTurn(runtime, credential, async () => {
      expect(
        await parse({ ...body, requestedActionPolicy: "model-approved" }),
      ).toBeNull();
    });
    await withOwnerDeviceActionTurn(runtime, credential, async () => {
      expect(await parse({ ...body, channelType: "GROUP" })).toBeNull();
    });
  } finally {
    await fixture.cleanup();
  }
});

test("retired asynchronous scopes and revoked devices cannot authorize a later send", async () => {
  const fixture = await createRealTestRuntime({
    characterName: "GmailPolicyRetirement",
    withLLM: false,
  });
  const runtime = fixture.runtime,
    owner = randomUUID(),
    service = new DeviceActionService(runtime),
    credential = {
      subjectUserId: `gateway:${owner}`,
      installationId: randomUUID(),
      deviceKey: "c".repeat(64),
      capabilities: ["gmail.request-policy.v1"],
    };
  try {
    await service.register(credential, "Retirement fixture");
    let release!: () => void, result!: Promise<unknown>;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withOwnerDeviceActionTurn(runtime, credential, async () => {
      const roomId = randomUUID(),
        key = randomUUID(),
        scope = "retired-policy",
        message: Memory = {
          id: conversationClientUserMemoryId(scope, key),
          agentId: runtime.agentId,
          entityId: owner,
          roomId,
          createdAt: Date.now(),
          content: {
            text: "Send QA",
            chatIdempotency: {
              version: 1,
              scope,
              clientMessageId: key,
              fingerprint: "e".repeat(64),
            },
          },
        };
      setDeviceReadReplyConversation(runtime, randomUUID(), roomId);
      setDeviceReadReplyContext(runtime, message, {} as ContextObject);
      bindDeviceRequestedActionPolicy(runtime, "initial-gmail-send-v1", key);
      result = gate.then(() =>
        requireSendConsent(
          runtime,
          message,
          sendConsentDigest({ retired: true }),
          { source: "gmail", requestMessageId: message.id },
        ),
      );
    });
    release();
    expect(await result).toBe("cancelled");
    await withOwnerDeviceActionTurn(runtime, credential, async () => {
      const roomId = randomUUID(),
        key = randomUUID(),
        scope = "revoked-policy",
        message: Memory = {
          id: conversationClientUserMemoryId(scope, key),
          agentId: runtime.agentId,
          entityId: owner,
          roomId,
          createdAt: Date.now(),
          content: {
            text: "Send QA",
            chatIdempotency: {
              version: 1,
              scope,
              clientMessageId: key,
              fingerprint: "f".repeat(64),
            },
          },
        };
      setDeviceReadReplyConversation(runtime, randomUUID(), roomId);
      setDeviceReadReplyContext(runtime, message, {} as ContextObject);
      bindDeviceRequestedActionPolicy(runtime, "initial-gmail-send-v1", key);
      await service.revoke(credential);
      await expect(
        requireSendConsent(
          runtime,
          message,
          sendConsentDigest({ revoked: true }),
          { source: "gmail", requestMessageId: message.id },
        ),
      ).rejects.toThrow();
    });
  } finally {
    await fixture.cleanup();
  }
});

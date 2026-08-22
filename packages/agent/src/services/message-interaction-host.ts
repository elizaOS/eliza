/**
 * Registers the single host-owned coordinator for durable connector interactions.
 * It prepares safe renderer inputs and dispatches authenticated callbacks only
 * through idempotent effect handlers owned by the application host.
 */

import path from "node:path";
import {
  type ConsumeMessageInteractionRequest,
  decodeMessageInteractionCallback,
  ElizaError,
  type IAgentRuntime,
  MESSAGE_INTERACTION_CALLBACK_BYTES,
  MESSAGE_INTERACTION_HOST_SERVICE,
  type MessageInteractionHost,
  type MessageInteractionHostConsumeOutcome,
  type MessageInteractionHostEffectHandler,
  type MessageInteractionHostReceipt,
  type MessageInteractionSession,
  MessageInteractionSessionAuthority,
  type MessageInteractionSessionStore,
  negotiateInteractionDelivery,
  type PreparedMessageInteraction,
  type PrepareMessageInteractionRequest,
  Service,
} from "@elizaos/core";
import { resolveStateDir } from "../config/paths.ts";
import { FileMessageInteractionSessionStore } from "./message-interaction-session-store.ts";

export interface MessageInteractionHostServiceOptions {
  store?: MessageInteractionSessionStore;
  clock?: () => number;
  referenceFactory?: () => string;
  claimTtlMs?: number;
}

function requiredText(value: string, pathName: string): string {
  const normalized = value.trim();
  if (!normalized || new TextEncoder().encode(normalized).length > 512) {
    throw new ElizaError(`${pathName} is invalid.`, {
      code: "INVALID_MESSAGE_INTERACTION_HOST_INPUT",
      context: { path: pathName },
    });
  }
  return normalized;
}

function canonicalTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : Number.NaN;
}

function assertSafeResult(
  value: unknown,
  pathName: string,
  redact: (text: string) => string,
): asserts value is Readonly<Record<string, string | number | boolean | null>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ElizaError(`${pathName} must be a result object.`, {
      code: "INVALID_MESSAGE_INTERACTION_EFFECT_RECEIPT",
      context: { path: pathName },
    });
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (
      new TextEncoder().encode(key).length > 512 ||
      (typeof fieldValue === "string" &&
        new TextEncoder().encode(fieldValue).length > 65_536) ||
      (typeof fieldValue === "number" && !Number.isFinite(fieldValue))
    ) {
      throw new ElizaError(`${pathName} contains an unbounded field.`, {
        code: "INVALID_MESSAGE_INTERACTION_EFFECT_RECEIPT",
        context: { path: `${pathName}.${key}` },
      });
    }
    if (
      fieldValue !== null &&
      typeof fieldValue !== "string" &&
      typeof fieldValue !== "number" &&
      typeof fieldValue !== "boolean"
    ) {
      throw new ElizaError(`${pathName} contains a non-scalar field.`, {
        code: "INVALID_MESSAGE_INTERACTION_EFFECT_RECEIPT",
        context: { path: `${pathName}.${key}` },
      });
    }
    if (/secret|password|token|api.?key|oauth.*code/i.test(key)) {
      throw new ElizaError(`${pathName} contains a secret-bearing field.`, {
        code: "MESSAGE_INTERACTION_SECRET_FORBIDDEN",
        context: { path: `${pathName}.${key}` },
      });
    }
    if (typeof fieldValue === "string" && redact(fieldValue) !== fieldValue) {
      throw new ElizaError(`${pathName} contains secret material.`, {
        code: "MESSAGE_INTERACTION_SECRET_FORBIDDEN",
        context: { path: `${pathName}.${key}` },
      });
    }
  }
}

function hostReceipt(
  value: unknown,
  expectedProvider: ConsumeMessageInteractionRequest["providerReceipt"],
  redact: (text: string) => string,
): MessageInteractionHostReceipt {
  if (!value || typeof value !== "object") {
    throw new ElizaError("Interaction host receipt is invalid.", {
      code: "MESSAGE_INTERACTION_STORE_PROTOCOL",
    });
  }
  const receipt = value as Partial<MessageInteractionHostReceipt>;
  if (
    typeof receipt.receiptId !== "string" ||
    typeof receipt.idempotencyKey !== "string" ||
    receipt.status !== "completed" ||
    typeof receipt.completedAt !== "string" ||
    typeof receipt.canonicalInboundEventId !== "string" ||
    !receipt.providerReceipt ||
    typeof receipt.auditId !== "string" ||
    !receipt.appStateResult ||
    !receipt.result
  ) {
    throw new ElizaError("Interaction host receipt is incomplete.", {
      code: "MESSAGE_INTERACTION_STORE_PROTOCOL",
    });
  }
  requiredText(receipt.receiptId, "receipt.receiptId");
  requiredText(receipt.idempotencyKey, "receipt.idempotencyKey");
  requiredText(
    receipt.canonicalInboundEventId,
    "receipt.canonicalInboundEventId",
  );
  requiredText(receipt.auditId, "receipt.auditId");
  if (!Number.isFinite(canonicalTimestamp(receipt.completedAt))) {
    throw new ElizaError("Interaction receipt completion time is invalid.", {
      code: "MESSAGE_INTERACTION_STORE_PROTOCOL",
    });
  }
  if (
    receipt.idempotencyKey !== expectedProvider.inboundEventId ||
    receipt.providerReceipt.source !== expectedProvider.source ||
    receipt.providerReceipt.accountId !== expectedProvider.accountId ||
    receipt.providerReceipt.inboundEventId !==
      expectedProvider.inboundEventId ||
    receipt.providerReceipt.receivedAt !== expectedProvider.receivedAt
  ) {
    throw new ElizaError(
      "Interaction provider receipt changed during replay.",
      {
        code: "MESSAGE_INTERACTION_STORE_PROTOCOL",
      },
    );
  }
  assertSafeResult(receipt.appStateResult, "receipt.appStateResult", redact);
  assertSafeResult(receipt.result, "receipt.result", redact);
  return structuredClone(receipt as MessageInteractionHostReceipt);
}

export class MessageInteractionHostService
  extends Service
  implements MessageInteractionHost
{
  static override serviceType = MESSAGE_INTERACTION_HOST_SERVICE;

  override capabilityDescription =
    "Durable capability-negotiated connector interactions with host-owned exactly-once effects";

  private readonly store: MessageInteractionSessionStore;
  private readonly authority: MessageInteractionSessionAuthority;
  private readonly handlers = new Map<
    string,
    MessageInteractionHostEffectHandler
  >();
  private readonly clock: () => number;

  constructor(
    runtime: IAgentRuntime,
    options: MessageInteractionHostServiceOptions = {},
  ) {
    super(runtime);
    this.clock = options.clock ?? Date.now;
    const agentId = requiredText(runtime.agentId, "runtime.agentId");
    if (
      path.basename(agentId) !== agentId ||
      agentId === "." ||
      agentId === ".."
    ) {
      throw new ElizaError("Runtime agent id is not a safe path component.", {
        code: "INVALID_MESSAGE_INTERACTION_HOST_PATH",
      });
    }
    this.store =
      options.store ??
      new FileMessageInteractionSessionStore({
        stateDirectory: path.join(
          resolveStateDir(),
          "message-interactions",
          agentId,
        ),
        clock: this.clock,
      });
    this.authority = new MessageInteractionSessionAuthority(this.store, {
      clock: this.clock,
      referenceFactory: options.referenceFactory,
      claimTtlMs: options.claimTtlMs,
    });
  }

  static async start(
    runtime: IAgentRuntime,
  ): Promise<MessageInteractionHostService> {
    return new MessageInteractionHostService(runtime);
  }

  async stop(): Promise<void> {
    this.handlers.clear();
  }

  registerEffectHandler(
    kindValue: string,
    handler: MessageInteractionHostEffectHandler,
  ): () => void {
    const kind = requiredText(kindValue, "effect.kind");
    if (!handler || typeof handler.execute !== "function") {
      throw new ElizaError("Interaction effect handler is invalid.", {
        code: "INVALID_MESSAGE_INTERACTION_EFFECT_HANDLER",
        context: { kind },
      });
    }
    if (this.handlers.has(kind)) {
      throw new ElizaError(
        "Interaction effect handler is already registered.",
        {
          code: "MESSAGE_INTERACTION_EFFECT_HANDLER_COLLISION",
          context: { kind },
        },
      );
    }
    this.handlers.set(kind, handler);
    return () => {
      if (this.handlers.get(kind) === handler) this.handlers.delete(kind);
    };
  }

  async prepare(
    request: PrepareMessageInteractionRequest,
  ): Promise<PreparedMessageInteraction> {
    if (request.bindings.agentId !== this.runtime.agentId) {
      throw new ElizaError("Interaction belongs to another agent runtime.", {
        code: "MESSAGE_INTERACTION_AGENT_MISMATCH",
      });
    }
    const delivery = negotiateInteractionDelivery(
      request.block,
      request.profile,
      {
        ...request.negotiationContext,
        callbackBytes: MESSAGE_INTERACTION_CALLBACK_BYTES,
      },
    );
    const created = await this.authority.create({
      ...request,
      flow: delivery.mode,
    });
    return {
      block: structuredClone(request.block),
      delivery,
      ...(delivery.mode === "signed-hosted"
        ? { hostedUrl: request.negotiationContext?.signedHostedUrl }
        : {}),
      callbackData: created.callbackData,
      expiresAt: created.session.expiresAt,
      profileId: created.session.profileId,
    };
  }

  async consume(
    request: ConsumeMessageInteractionRequest,
  ): Promise<MessageInteractionHostConsumeOutcome> {
    try {
      const reference = decodeMessageInteractionCallback(request.callbackData);
      if (!reference) {
        throw new ElizaError(
          "Callback is not an opaque interaction reference.",
          {
            code: "INVALID_MESSAGE_INTERACTION_REFERENCE",
          },
        );
      }
      const provider = request.providerReceipt;
      const inboundEventId = requiredText(
        provider.inboundEventId,
        "providerReceipt.inboundEventId",
      );
      if (
        provider.source !== request.bindings.connector.source ||
        provider.accountId !== request.bindings.connector.accountId
      ) {
        throw new ElizaError(
          "Provider receipt belongs to another connector account.",
          { code: "MESSAGE_INTERACTION_PROVIDER_RECEIPT_MISMATCH" },
        );
      }
      if (!Number.isFinite(canonicalTimestamp(provider.receivedAt))) {
        throw new ElizaError("Provider receipt time is invalid.", {
          code: "INVALID_MESSAGE_INTERACTION_PROVIDER_RECEIPT",
        });
      }
      if (canonicalTimestamp(provider.receivedAt) > this.clock()) {
        throw new ElizaError("Provider receipt time is in the future.", {
          code: "INVALID_MESSAGE_INTERACTION_PROVIDER_RECEIPT",
        });
      }
      const prior = await this.store.get(reference);
      if (!prior) {
        throw new ElizaError("Interaction session was not found.", {
          code: "MESSAGE_INTERACTION_NOT_FOUND",
        });
      }
      const retained = prior.bindings;
      if (
        request.bindings.actorId !== retained.actorId ||
        request.bindings.audience.kind !== retained.audience.kind ||
        request.bindings.audience.id !== retained.audience.id ||
        request.bindings.agentId !== retained.agentId ||
        request.bindings.connector.source !== retained.connector.source ||
        request.bindings.connector.accountId !== retained.connector.accountId ||
        request.bindings.roomId !== retained.roomId
      ) {
        throw new ElizaError(
          "Authenticated provider bindings do not match the retained session.",
          { code: "MESSAGE_INTERACTION_BINDING_MISMATCH" },
        );
      }
      const preparedHandler = this.handlers.get(prior.effect.kind);
      if (!preparedHandler) {
        throw new ElizaError("Interaction effect handler is unavailable.", {
          code: "MESSAGE_INTERACTION_EFFECT_HANDLER_UNAVAILABLE",
          context: { kind: prior.effect.kind },
        });
      }
      const consumed = await this.authority.consume({
        callbackData: request.callbackData,
        // The original outbound message binding is host-retained state. Provider
        // callbacks authenticate the actor/room/account but cannot reconstruct it.
        bindings: retained,
        replayKey: inboundEventId,
        response: request.response,
        executor: {
          execute: async (args) => {
            const effect = await preparedHandler.execute({
              ...args,
              providerReceipt: structuredClone(provider),
            });
            requiredText(effect.receiptId, "effectReceipt.receiptId");
            requiredText(
              effect.canonicalInboundEventId,
              "effectReceipt.canonicalInboundEventId",
            );
            requiredText(effect.auditId, "effectReceipt.auditId");
            assertSafeResult(
              effect.appStateResult,
              "effectReceipt.appStateResult",
              (text) => this.runtime.redactSecrets(text),
            );
            assertSafeResult(effect.result, "effectReceipt.result", (text) =>
              this.runtime.redactSecrets(text),
            );
            return {
              receiptId: effect.receiptId,
              idempotencyKey: args.idempotencyKey,
              status: "completed" as const,
              completedAt: new Date(this.clock()).toISOString(),
              canonicalInboundEventId: effect.canonicalInboundEventId,
              providerReceipt: structuredClone(provider),
              auditId: effect.auditId,
              appStateResult: structuredClone(effect.appStateResult),
              result: structuredClone(effect.result),
            };
          },
        },
      });
      if ("status" in consumed && consumed.status === "in_progress") {
        return consumed;
      }
      return {
        status: prior.consume.state === "completed" ? "replay" : "completed",
        receipt: hostReceipt(consumed, provider, (text) =>
          this.runtime.redactSecrets(text),
        ),
      };
    } catch (error) {
      // error-policy:J1 Connector callbacks are an untrusted transport
      // boundary; stable domain failures become explicit denied outcomes.
      if (error instanceof ElizaError) {
        return { status: "denied", code: error.code, message: error.message };
      }
      throw error;
    }
  }

  async revoke(request: {
    reference: string;
    decisionId: string;
    now?: number;
  }): Promise<MessageInteractionSession> {
    return this.store.revokeAuthorization({
      reference: request.reference,
      decisionId: request.decisionId,
      now: request.now ?? this.clock(),
    });
  }

  async get(reference: string): Promise<MessageInteractionSession | null> {
    return this.store.get(reference);
  }
}

/** Resolve the concrete host service without constructing a competing store. */
export function resolveMessageInteractionHostService(
  runtime: IAgentRuntime,
): MessageInteractionHostService | null {
  return runtime.getService<MessageInteractionHostService>(
    MESSAGE_INTERACTION_HOST_SERVICE,
  );
}

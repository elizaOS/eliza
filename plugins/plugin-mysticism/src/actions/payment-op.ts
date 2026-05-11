import type {
  Action,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  JsonValue,
  Memory,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";

import type { MysticismService } from "../services/mysticism-service";

type PaymentOp = "check" | "request";
const PAYMENT_AMOUNT_MAX_CHARS = 32;

interface PaymentOpParams {
  action?: unknown;
  amount?: unknown;
  entityId?: unknown;
  roomId?: unknown;
}

function readParam(
  options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
  key: keyof PaymentOpParams
): unknown {
  if (!options || typeof options !== "object") {
    return undefined;
  }
  const handler = options as HandlerOptions;
  const params = handler.parameters as PaymentOpParams | undefined;
  if (params && key in params && params[key] !== undefined) {
    return params[key];
  }
  return (options as Record<string, unknown>)[key];
}

function isPaymentOp(value: unknown): value is PaymentOp {
  return value === "check" || value === "request";
}

export const paymentOpAction: Action = {
  name: "MYSTICISM_PAYMENT",
  contexts: ["finance", "payments"],
  contextGate: { anyOf: ["finance", "payments"] },
  roleGate: { minRole: "OWNER" },
  similes: [
    "REQUEST_PAYMENT",
    "CHARGE_USER",
    "ASK_FOR_PAYMENT",
    "SET_PRICE",
    "CHECK_PAYMENT",
    "VERIFY_PAYMENT",
    "PAYMENT_STATUS",
    "PAYMENT",
  ],
  description:
    "Payment router for the active mysticism reading session. Set action to 'check' to read payment status, or 'request' to ask the user to pay (set amount or include $X.XX in the message).",
  descriptionCompressed: "Mysticism payment ops: check, request.",

  parameters: [
    {
      name: "action",
      description: "Operation: check or request.",
      required: true,
      schema: { type: "string" as const, enum: ["check", "request"] },
    },
    {
      name: "amount",
      description: "For request — payment amount as a string (e.g. '3.00').",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "entityId",
      description:
        "For check — optional entity id whose active reading payment should be checked. Defaults to the current sender.",
      required: false,
      schema: { type: "string" as const },
    },
    {
      name: "roomId",
      description:
        "For check — optional room id whose active reading payment should be checked. Defaults to the current room.",
      required: false,
      schema: { type: "string" as const },
    },
  ],

  validate: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<boolean> => {
    return runtime.getService<MysticismService>("MYSTICISM") !== null;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    options?: HandlerOptions | Record<string, JsonValue | undefined>,
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    const service = runtime.getService<MysticismService>("MYSTICISM");
    if (!service) {
      return { success: false, text: "Mysticism service not available." };
    }

    const opRaw = readParam(options, "action");
    if (!isPaymentOp(opRaw)) {
      return {
        success: false,
        text: `PAYMENT_OP requires op in {check, request}, got ${String(opRaw)}`,
      };
    }

    if (opRaw === "check") {
      const entityRaw = readParam(options, "entityId");
      const roomRaw = readParam(options, "roomId");
      const entityId = typeof entityRaw === "string" ? entityRaw : message.entityId;
      const roomId = typeof roomRaw === "string" ? roomRaw : message.roomId;
      const session = service.getSession(entityId, roomId);
      if (!session) {
        return { success: false, text: "No active session." };
      }
      return {
        success: true,
        text: `Payment status: ${session.paymentStatus}`,
        data: {
          paymentStatus: session.paymentStatus,
          amount: session.paymentAmount,
          txHash: session.paymentTxHash,
          readingType: session.type,
        },
      };
    }

    // request
    const session = service.getSession(message.entityId, message.roomId);
    if (!session) {
      return { success: false, text: "No active reading session." };
    }
    const amountRaw = readParam(options, "amount");
    let amount: string;
    if (typeof amountRaw === "string" && amountRaw.length > 0) {
      amount = amountRaw.slice(0, PAYMENT_AMOUNT_MAX_CHARS);
    } else {
      const text = message.content.text ?? "";
      const amountMatch = text.match(/\$?([\d.]+)/);
      amount = amountMatch ? amountMatch[1] : "1.00";
    }

    service.markPaymentRequested(message.entityId, message.roomId, amount);
    logger.info(
      { entityId: message.entityId, roomId: message.roomId, amount },
      "Payment requested for reading"
    );
    return {
      success: true,
      text: `Payment of $${amount} requested for ${session.type} reading.`,
      data: {
        sessionId: session.id,
        amount,
        readingType: session.type,
        paymentStatus: "requested",
      },
    };
  },

  examples: [
    [
      {
        name: "{{agentName}}",
        content: {
          text: "For a full Celtic Cross reading, I'd ask $3.00.",
          actions: ["MYSTICISM_PAYMENT"],
        },
      },
    ],
    [
      {
        name: "{{agentName}}",
        content: {
          text: "Let me check if your payment has come through...",
          actions: ["MYSTICISM_PAYMENT"],
        },
      },
    ],
  ],
};

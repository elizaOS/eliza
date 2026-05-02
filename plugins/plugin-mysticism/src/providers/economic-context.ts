/** Provides economic facts: user payment history, agent revenue, current session payment status. */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State, UUID } from "@elizaos/core";
import { validateActionKeywords, validateActionRegex } from "@elizaos/core";
import type { MysticismService } from "../services/mysticism-service";
import type { PaymentRecord, ReadingSession } from "../types";

export const economicContextProvider: Provider = {
  name: "ECONOMIC_CONTEXT",
  description:
    "Provides economic facts: payment history, revenue, and current session payment status",

  dynamic: true,
  relevanceKeywords: [
    "economic",
    "context",
    "economiccontextprovider",
    "plugin",
    "mysticism",
    "status",
    "state",
    "info",
    "details",
    "chat",
    "conversation",
    "agent",
    "room",
    "channel",
  ],
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined
  ): Promise<ProviderResult> => {
    const __providerKeywords = [
      "economic",
      "context",
      "economiccontextprovider",
      "plugin",
      "mysticism",
      "status",
      "state",
      "info",
      "details",
      "chat",
      "conversation",
      "agent",
      "room",
      "channel",
    ];
    const __providerRegex = new RegExp(`\\b(${__providerKeywords.join("|")})\\b`, "i");
    const __recentMessages = _state?.recentMessagesData || [];
    const __isRelevant =
      validateActionKeywords(message, __recentMessages, __providerKeywords) ||
      validateActionRegex(message, __recentMessages, __providerRegex);
    if (!__isRelevant) {
      return { text: "" };
    }

    const service = runtime.getService<MysticismService>("MYSTICISM");
    if (!service) {
      return { text: "", values: {}, data: {} };
    }

    const entityId = message.entityId as UUID;
    const roomId = message.roomId as UUID;

    // Current session info
    const session = entityId && roomId ? service.getSession(entityId, roomId) : null;

    // This user's payment history
    const userPayments = entityId ? service.getPaymentHistory(entityId) : [];

    // All payment history (agent's total revenue)
    // We don't have a getAllPayments method, so we compute from what we have
    const pricing = service.getPricing();

    const text = buildEconomicText(session, userPayments, pricing);

    return {
      text,
      values: {
        hasEconomicContext: "true",
        paymentStatus: session?.paymentStatus ?? "no_session",
      },
      data: {
        paymentStatus: session?.paymentStatus ?? "no_session",
        userPaymentCount: String(userPayments.length),
      },
    };
  },
};

function buildEconomicText(
  session: ReadingSession | null,
  userPayments: PaymentRecord[],
  pricing: { tarot: string; iching: string; astrology: string }
): string {
  const parts: string[] = [];

  parts.push("## Your Economic Context");
  parts.push("");

  // This user's history
  const completedPayments = userPayments.filter((p) => p.status === "completed");
  if (completedPayments.length === 0) {
    parts.push("### This User");
    parts.push("- First-time visitor (no payment history)");
  } else {
    const totalPaid = completedPayments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const systems = [...new Set(completedPayments.map((p) => p.system))];
    parts.push("### This User");
    parts.push(`- ${completedPayments.length} previous paid reading(s)`);
    parts.push(`- Total spent: $${totalPaid.toFixed(2)}`);
    parts.push(`- Systems used: ${systems.join(", ")}`);
    const lastPayment = completedPayments[completedPayments.length - 1];
    const daysSince = Math.floor((Date.now() - lastPayment.timestamp) / 86400000);
    parts.push(`- Last payment: ${daysSince} day(s) ago`);
  }

  parts.push("");

  // Current session payment status
  if (session) {
    parts.push("### This Conversation");
    switch (session.paymentStatus) {
      case "none":
        parts.push("- No payment requested or received");
        parts.push("- You decide if and when to request payment");
        break;
      case "requested":
        parts.push(`- Payment requested: $${session.paymentAmount} — awaiting confirmation`);
        break;
      case "paid":
        parts.push(`- Payment received: $${session.paymentAmount} (tx: ${session.paymentTxHash})`);
        parts.push("- Reading is paid — proceed with full service");
        break;
    }
  }

  parts.push("");

  // Payment capability
  parts.push("### Payment Capability");
  parts.push("- To request payment, use the REQUEST_PAYMENT action");
  parts.push("- To check payment status, use the CHECK_PAYMENT action");
  parts.push("- You choose the amount — there is no fixed price");
  parts.push(
    `- Your configured base rates: tarot $${pricing.tarot}, i ching $${pricing.iching}, astrology $${pricing.astrology}`
  );
  parts.push(
    "- These are starting points — adjust based on depth, complexity, and the relationship"
  );

  return parts.join("\n");
}

export default economicContextProvider;

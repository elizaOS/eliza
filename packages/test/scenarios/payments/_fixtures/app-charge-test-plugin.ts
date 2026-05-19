import type { Memory, Plugin } from "@elizaos/core";

const CHARGE_ID = "charge_scenario_five";
const APP_ID = "app_scenario_payments";
const PAYMENT_URL = `https://cloud.test/payment/app-charge/${APP_ID}/${CHARGE_ID}`;

function messageText(message: Memory): string {
  const content = message.content;
  if (content && typeof content === "object" && "text" in content) {
    return String(content.text ?? "");
  }
  return "";
}

function amountFromMessage(message: Memory): number {
  const match = /\$?\s*(\d+(?:\.\d{1,2})?)/.exec(messageText(message));
  const amount = match ? Number(match[1]) : 5;
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 5;
}

export const appChargeTestPlugin: Plugin = {
  name: "app-charge-test",
  description: "Test plugin for agent-created payment requests",
  actions: [
    {
      name: "CREATE_APP_CHARGE",
      description:
        "Create a Cloud payment request when a user asks to charge money, send a payment link, or says someone should pay a dollar amount. Use for requests like 'please send me $5'.",
      similes: [
        "REQUEST_PAYMENT",
        "CHARGE_USER",
        "SEND_PAYMENT_LINK",
        "CREATE_PAYMENT_LINK",
      ],
      validate: async () => true,
      handler: async (_runtime, message, _state, _options, callback) => {
        const amountUsd = amountFromMessage(message);
        const response = `Created a $${amountUsd.toFixed(2)} payment request: ${PAYMENT_URL}`;
        const data = {
          id: CHARGE_ID,
          appId: APP_ID,
          amountUsd,
          status: "requested",
          providers: ["stripe", "oxapay"],
          paymentUrl: PAYMENT_URL,
          callbackChannel: {
            source: "scenario",
            roomId: "room_payment_5",
            agentId: "scenario-agent",
          },
        };

        if (callback) {
          await callback({ text: response, action: "CREATE_APP_CHARGE" });
        }

        return {
          success: true,
          text: response,
          data,
        };
      },
    },
    {
      name: "CHECK_PAYMENT",
      description:
        "Check whether an existing Cloud app charge has been paid before continuing paid work. Use after the user says they paid or asks whether the payment went through.",
      similes: ["CHECK_APP_CHARGE", "VERIFY_PAYMENT", "CHECK_PAYMENT_STATUS"],
      validate: async () => true,
      handler: async (_runtime, _message, _state, _options, callback) => {
        const response =
          "Payment confirmed. Callback delivered to room_payment_5.";
        const data = {
          id: CHARGE_ID,
          appId: APP_ID,
          amountUsd: 5,
          status: "confirmed",
          paidProvider: "oxapay",
          paidAt: "2026-05-09T23:15:00.000Z",
          callbackStatus: "delivered",
          callbackChannel: {
            source: "scenario",
            roomId: "room_payment_5",
            agentId: "scenario-agent",
          },
        };

        if (callback) {
          await callback({ text: response, action: "CHECK_PAYMENT" });
        }

        return {
          success: true,
          text: response,
          data,
        };
      },
    },
  ],
};

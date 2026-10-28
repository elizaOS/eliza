import { discordDeliveryReceiptStore } from "../../gateway-discord/src/delivery-receipts";
import { deliverInternalDiscordMessage } from "../../gateway-discord/src/internal-delivery";

let sends = 0;
let lastNonce = "";

import { handleDeliveryReceipts, receiptOwner } from "./delivery-receipt-state";

export { DeliveryReceiptState } from "./delivery-receipt-state";
export default {
  async fetch(
    request: Request,
    env: { DELIVERY_RECEIPT_STATE: DurableObjectNamespace },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/discord/deliver") {
      const stateEnv = {
        ...env,
        GATEWAY_KIND: "discord",
        GATEWAY_RUNTIME_CONFIG: JSON.stringify({
          CLOUD_GATEWAY_RECEIPTS_BACKEND: "cloudflare",
          GATEWAY_RECEIPTS_TOKEN: "test-only",
        }),
      };
      const unexpectedRedis = async () => {
        throw new Error("Unexpected Redis fallback");
      };
      const receipts = discordDeliveryReceiptStore(
        { get: unexpectedRedis, set: unexpectedRedis, delete: unexpectedRedis },
        {
          CLOUD_GATEWAY_RECEIPTS_BACKEND: "cloudflare",
          GATEWAY_RECEIPTS_URL:
            "https://receipt.test/internal/delivery-receipts",
          GATEWAY_RECEIPTS_TOKEN: "test-only",
        },
        (address, init) =>
          handleDeliveryReceipts(new Request(address, init), stateEnv),
      );
      const response = await deliverInternalDiscordMessage(request, {
        getInternalSecret: () => "delivery-test-only",
        receipts,
        sendDirectMessage: async (input) => {
          sends++;
          lastNonce = input.nonce;
          if (url.searchParams.get("outcome") === "unknown")
            throw new Error("Transport acceptance unknown");
          return {
            accepted: true,
            providerMessageId: "discord-fixture-message",
          };
        },
      });
      response.headers.set("X-Fixture-Sends", String(sends));
      response.headers.set("X-Fixture-Nonce", lastNonce);
      return response;
    }
    if (url.pathname === "/private") {
      const input = (await request.clone().json()) as { key: string };
      return env.DELIVERY_RECEIPT_STATE.getByName(
        receiptOwner(url.searchParams.get("owner") ?? input.key),
      ).fetch(request);
    }
    return handleDeliveryReceipts(request, {
      ...env,
      GATEWAY_KIND: "webhook",
      GATEWAY_RUNTIME_CONFIG: JSON.stringify({
        CLOUD_GATEWAY_RECEIPTS_BACKEND: "cloudflare",
        GATEWAY_RECEIPTS_TOKEN: "test-only",
      }),
    });
  },
};

import {
  HOLD_INDEX_KEY,
  HOLD_LEASE_PREFIX,
  HOLD_RECORD_PREFIX,
  HOLD_REMOVE_SCRIPT,
} from "@elizaos/cloud-services-common/webhook-ingress";
import { withCloudflareIngress } from "../../gateway-webhook/src/cloudflare-ingress";
import {
  drainCutoverHolds,
  holdWebhookForCutover,
} from "../../gateway-webhook/src/cutover-hold";
import type { GatewayRedis } from "../../gateway-webhook/src/redis";
import { handleWebhookIngress } from "./webhook-ingress-state";

export { WebhookIngressState } from "./webhook-ingress-state";

let deliveries = 0;
export default {
  async fetch(
    request: Request,
    env: { WEBHOOK_INGRESS_STATE: DurableObjectNamespace },
  ) {
    const url = new URL(request.url);
    if (url.pathname === "/private")
      return env.WEBHOOK_INGRESS_STATE.getByName("webhook-ingress-v1").fetch(
        request,
      );
    const settings = {
      ...env,
      GATEWAY_KIND: "webhook",
      GATEWAY_RUNTIME_CONFIG: JSON.stringify({
        CLOUD_WEBHOOK_INGRESS_BACKEND: "cloudflare",
        WEBHOOK_INGRESS_TOKEN: "test-only",
      }),
    };
    if (url.pathname === "/internal/webhook-ingress")
      return handleWebhookIngress(request, settings);
    const input = (await request.json()) as {
      action: string;
      key: string;
      value: string;
      delay?: number;
      token?: string;
      ex?: number;
      nx?: boolean;
    };
    const redis = new Proxy({} as GatewayRedis, {
      get: () => () => {
        throw new Error("Unexpected Redis fallback");
      },
    });
    const store = withCloudflareIngress(
      redis,
      {
        CLOUD_WEBHOOK_INGRESS_BACKEND: "cloudflare",
        WEBHOOK_INGRESS_URL: "https://ingress.test/internal/webhook-ingress",
        WEBHOOK_INGRESS_TOKEN: "test-only",
      },
      (address, init) =>
        handleWebhookIngress(new Request(address, init), settings),
    );
    let result: unknown;
    switch (input.action) {
      case "get":
        result = await store.get(input.key);
        break;
      case "set":
        result = await store.set(input.key, input.value, {
          ex: input.ex,
          nx: input.nx,
        });
        break;
      case "del":
        result = await store.del(input.key);
        break;
      case "due":
        result = await store.zrangebyscore(HOLD_INDEX_KEY, 0, Date.now(), 100);
        break;
      case "hold":
        result = await holdWebhookForCutover(
          store,
          {
            dedupKey: input.key,
            platform: "blooio",
            project: "project",
            traceId: "fixture",
            event: {
              platform: "blooio",
              messageId: input.key,
              chatId: "fixture",
              senderId: "fixture",
              text: input.value,
              rawPayload: {},
            },
            code: "personal_cutover_in_progress",
          },
          { code: "personal_cutover_in_progress", retryAfterSeconds: 1 },
          Date.now() - 2000,
          input.token
            ? { key: HOLD_LEASE_PREFIX + input.key, token: input.token }
            : undefined,
        );
        break;
      case "cleanup":
        result = await store.eval(
          HOLD_REMOVE_SCRIPT,
          [
            HOLD_LEASE_PREFIX + input.key,
            HOLD_RECORD_PREFIX + input.key,
            HOLD_INDEX_KEY,
            input.key,
          ],
          [input.token ?? "", input.key, "held"],
        );
        break;
      case "drain":
        result = await drainCutoverHolds(
          store,
          {
            redeliver: async (held) => {
              deliveries++;
              await new Promise((resolve) =>
                setTimeout(resolve, input.delay ?? 0),
              );
              await store.set(held.dedupKey, "delivered", { ex: 60 });
              return { kind: "delivered" };
            },
            release: async (held) => {
              await store.set(held.dedupKey, "expired", { ex: 60 });
            },
          },
          { leaseSeconds: 1 },
        );
        break;
      default:
        return new Response("Invalid fixture action", { status: 400 });
    }
    return Response.json({ result, deliveries });
  },
};

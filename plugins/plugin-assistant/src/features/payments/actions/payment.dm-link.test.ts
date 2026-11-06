/** PAYMENT deliver_link to a "dm" adapter against a real runtime dispatch registry. */
import {
  type AgentRuntime,
  createCharacter,
  type DispatchSensitiveRequest,
  type IAgentRuntime,
  type Memory,
  SensitiveRequestDispatchRegistryService,
  Service,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import {
  PAYMENT_REQUESTS_CLIENT_SERVICE,
  type PaymentRequestEnvelope,
} from "../types.ts";
import { paymentAction } from "./payment.ts";

const HOSTED_URL = "https://checkout.example.test/session/pay_dm_1";

let storedEnvelope: PaymentRequestEnvelope | null = null;

/** Cloud boundary: returns the stored payment request. */
class StoredPaymentRequestsClient extends Service {
  static override serviceType = PAYMENT_REQUESTS_CLIENT_SERVICE;
  override capabilityDescription = "Stored payment requests";
  static override async start(runtime: IAgentRuntime) {
    return new StoredPaymentRequestsClient(runtime);
  }
  override async stop() {}
  async create(): Promise<PaymentRequestEnvelope> {
    throw new Error("not used");
  }
  async get(id: string): Promise<PaymentRequestEnvelope | null> {
    return storedEnvelope?.paymentRequestId === id ? storedEnvelope : null;
  }
  async cancel() {}
}

const runtimes: AgentRuntime[] = [];
afterEach(async () => {
  storedEnvelope = null;
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
});

async function runtimeWithDmAdapter() {
  const delivered: DispatchSensitiveRequest[] = [];
  const runtime = createSQLiteTestRuntime({
    character: createCharacter({ name: "PaymentDm" }),
    logLevel: "fatal",
    enableAutonomy: false,
  });
  runtimes.push(runtime);
  await runtime.initialize({ skipMigrations: true });
  await runtime.registerService(SensitiveRequestDispatchRegistryService);
  await runtime.registerService(StoredPaymentRequestsClient);
  const registry = await runtime.getServiceLoadPromise(
    SensitiveRequestDispatchRegistryService.serviceType,
  );
  await runtime.getServiceLoadPromise(PAYMENT_REQUESTS_CLIENT_SERVICE);
  // The connector DM adapters (Telegram, iMessage, Discord) DM the link they
  // read from `callback.url`; this one records what it is handed.
  (registry as SensitiveRequestDispatchRegistryService).register({
    target: "dm",
    async deliver({ request, channelId }) {
      delivered.push(request);
      return { delivered: true, target: "dm", channelId };
    },
  });
  return { runtime, delivered };
}

function payerMessage(runtime: AgentRuntime): Memory {
  return {
    id: crypto.randomUUID() as UUID,
    entityId: crypto.randomUUID() as UUID,
    agentId: runtime.agentId,
    roomId: crypto.randomUUID() as UUID,
    content: { text: "send me the payment link", source: "telegram" },
  };
}

function envelope(
  overrides: Partial<PaymentRequestEnvelope> = {},
): PaymentRequestEnvelope {
  return {
    paymentRequestId: "pay_dm_1",
    provider: "stripe",
    amountCents: 2500,
    currency: "USD",
    paymentContext: { kind: "any_payer" },
    hostedUrl: HOSTED_URL,
    expiresAt: Date.now() + 600_000,
    status: "pending",
    reason: "Invoice #7",
    ...overrides,
  };
}

describe("PAYMENT deliver_link to a DM", () => {
  it("hands the DM adapter the payment's hosted URL as the link to send", async () => {
    const { runtime, delivered } = await runtimeWithDmAdapter();
    storedEnvelope = envelope();

    const result = await paymentAction.handler(
      runtime,
      payerMessage(runtime),
      undefined,
      {
        parameters: {
          action: "deliver_link",
          paymentRequestId: "pay_dm_1",
          target: "dm",
          targetChannelId: "424242",
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.callback).toEqual({ url: HOSTED_URL });
  });

  it("hands the DM adapter no link when the payment has no hosted URL", async () => {
    const { runtime, delivered } = await runtimeWithDmAdapter();
    storedEnvelope = envelope({
      paymentContext: { kind: "verified_payer", scope: "owner" },
      hostedUrl: undefined,
    });

    const result = await paymentAction.handler(
      runtime,
      payerMessage(runtime),
      undefined,
      {
        parameters: {
          action: "deliver_link",
          paymentRequestId: "pay_dm_1",
          target: "dm",
          targetChannelId: "424242",
        },
      },
    );

    expect(result?.success).toBe(true);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toHaveProperty("callback");
  });
});

/**
 * An org-funded Shared stream that stops after delivery is billed for the
 * reply it already delivered, not for the admitted 500-token output estimate.
 * The real `SharedRuntimeChatService.stream` runs; a client disconnect is a
 * real `request.signal` abort or a real response-body cancel. Real pricing,
 * billing and ledger rows on PGlite. Only the provider stream, the org rate
 * limit and the reservation settlers are replaced (first settle wins, as in
 * production).
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
process.env.MOCK_REDIS ||= "1";

const ORG_ID = "00000000-0000-0000-0000-00000000d001";
const USER_ID = "00000000-0000-0000-0000-00000000d002";
const MODEL = "anthropic/claude-sonnet-4-6";
const OUTPUT_PRICE = 15e-6;

let dbWrite: typeof import("../../../db/client").dbWrite;
let closeDb: typeof import("../../../db/client").closeDatabaseConnectionsForTests | undefined;

beforeAll(async () => {
  ({ closeDatabaseConnectionsForTests: closeDb, dbWrite } = await import("../../../db/client"));
  const { pushSchemaToTestDb } = await import("../../../db/push-schema-for-tests");
  const { aiPricingEntries } = await import("../../../db/schemas/ai-pricing");
  const { aiBillingRecords } = await import("../../../db/schemas/ai-billing-records");
  const { organizations } = await import("../../../db/schemas/organizations");
  const { users } = await import("../../../db/schemas/users");
  const { apiKeys } = await import("../../../db/schemas/api-keys");
  const { usageRecords } = await import("../../../db/schemas/usage-records");
  const { creditTransactions } = await import("../../../db/schemas/credit-transactions");
  await pushSchemaToTestDb({
    aiPricingEntries,
    organizations,
    users,
    apiKeys,
    usageRecords,
    creditTransactions,
    aiBillingRecords,
  });
  await dbWrite.execute(
    `INSERT INTO organizations (id, name, slug) VALUES ('${ORG_ID}', 'Acme', 'acme-${ORG_ID}');`,
  );
  await dbWrite.execute(
    `INSERT INTO users (id, organization_id, steward_user_id) VALUES ('${USER_ID}', '${ORG_ID}', 'shared-cancel');`,
  );
  const { aiPricingRepository } = await import("../../../db/repositories/ai-pricing");
  for (const [chargeType, unitPrice] of [
    ["input", 3e-6],
    ["output", OUTPUT_PRICE],
  ] as const) {
    await aiPricingRepository.createManualOverride({
      billingSource: "bitrouter",
      provider: "anthropic",
      model: MODEL,
      productFamily: "language",
      chargeType,
      unit: "token",
      unitPrice,
      dimensionKey: "*",
      dimensions: {},
      reason: "test: isolated prices",
      updatedBy: "test",
    });
  }
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

const PROVIDER_STOPPED = "provider stopped";

let reservation: { exact: number[]; unknown: number; settled: boolean } = {
  exact: [],
  unknown: 0,
  settled: false,
};
let deltas: string[] = [];

const realTurn = await import("./run-shared-agent-turn");
mock.module("./run-shared-agent-turn", () => ({
  ...realTurn,
  resolveSharedAgentTurnModel: () => MODEL,
  // Delivers `deltas`, then waits like a slow provider until generation stops.
  runSharedAgentTurnStream: async (input: { abortSignal?: AbortSignal }) => ({
    model: MODEL,
    degraded: false,
    parts: (async function* () {
      for (const text of deltas) yield { type: "text-delta" as const, text };
      await new Promise((_resolve, reject) => {
        input.abortSignal?.addEventListener("abort", () => reject(new Error(PROVIDER_STOPPED)), {
          once: true,
        });
      });
    })(),
  }),
}));
const realRateLimit = await import("../../middleware/rate-limit");
mock.module("../../middleware/rate-limit", () => ({
  ...realRateLimit,
  enforceOrgRateLimit: async () => null,
}));
const realAdmission = await import("../organization-inference-admission");
mock.module("../organization-inference-admission", () => ({
  ...realAdmission,
  admitOrganizationInference: async () => ({
    reservation: undefined,
    settle: async (amount: number) => {
      if (reservation.settled) return null;
      reservation.settled = true;
      reservation.exact.push(amount);
      return null;
    },
    settleUnknown: async () => {
      if (reservation.settled) return null;
      reservation.settled = true;
      reservation.unknown += 1;
      return null;
    },
    markProviderDispatched: () => {},
  }),
}));

const agent = {
  id: "agent-shared-cancel",
  organization_id: ORG_ID,
  user_id: USER_ID,
  character_id: null,
  agent_name: "Shared cancel",
  agent_config: null,
  execution_tier: "shared",
} as const;

const historyStore = {
  load: async () => [],
  merge: async () => [],
};

async function billingRows(): Promise<Array<{ usage_total_cost: string }>> {
  const rows = await dbWrite.execute(
    `SELECT usage_total_cost FROM ai_billing_records WHERE organization_id = '${ORG_ID}';`,
  );
  return rows.rows as Array<{ usage_total_cost: string }>;
}

/** The ledger row is written after settlement, off the response path. */
async function waitForBillingRows(count: number): Promise<Array<{ usage_total_cost: string }>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await billingRows();
    if (rows.length >= count) return rows;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return billingRows();
}

/**
 * Streams `delivered` to the client, then disconnects it with `disconnect`
 * and waits until the turn is settled.
 */
async function streamThenDisconnect(
  delivered: string[],
  disconnect: "request-abort" | "body-cancel",
): Promise<void> {
  const { sharedRuntimeChatService } = await import("./shared-runtime-chat");
  reservation = { exact: [], unknown: 0, settled: false };
  deltas = delivered;
  const request = new AbortController();
  const response = await sharedRuntimeChatService.stream(
    agent as never,
    {
      jsonrpc: "2.0",
      id: `shared-cancel-${disconnect}`,
      method: "message.send",
      params: { roomId: "cancel-room", text: "write a long report" },
    },
    { abortSignal: request.signal, historyStore, funding: "organization-credits" },
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  while (received.split("event: chunk").length - 1 < delivered.length) {
    const next = await reader.read();
    if (next.done) throw new Error("stream ended before delivery");
    received += decoder.decode(next.value);
  }
  if (disconnect === "request-abort") {
    request.abort();
    // The stream fails and closes; finalization may finish after the close.
    while (!(await reader.read()).done) {}
  } else {
    await reader.cancel("client closed the tab");
  }
  for (let attempt = 0; attempt < 100 && !reservation.settled; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const longReply = Array.from({ length: 40 }, () =>
  "The quick brown fox jumps over the lazy dog. ".repeat(10),
);

for (const disconnect of ["request-abort", "body-cancel"] as const) {
  test(`a ${disconnect} after delivery is billed for the delivered reply`, async () => {
    const { estimateInputTokens } = await import("../ai-billing");
    const deliveredTokens = estimateInputTokens([{ content: longReply.join("") }]);
    expect(deliveredTokens).toBeGreaterThan(2_000);
    const before = (await billingRows()).length;

    await streamThenDisconnect(longReply, disconnect);

    expect(reservation.unknown).toBe(0);
    expect(reservation.exact).toHaveLength(1);
    expect(reservation.exact[0]).toBeGreaterThanOrEqual(deliveredTokens * OUTPUT_PRICE);
    expect(reservation.exact[0]).toBeGreaterThan(500 * OUTPUT_PRICE * 4);
    const rows = await waitForBillingRows(before + 1);
    expect(rows).toHaveLength(before + 1);
    expect(Number(rows.at(-1)?.usage_total_cost)).toBeCloseTo(reservation.exact[0], 5);
  });

  test(`a ${disconnect} within the admitted estimate keeps the estimate`, async () => {
    const before = (await billingRows()).length;
    await streamThenDisconnect(["A short start."], disconnect);
    expect(reservation.exact).toEqual([]);
    expect(reservation.unknown).toBe(1);
    expect(await billingRows()).toHaveLength(before);
  });
}

/**
 * Proves the owner bills route classifies due dates on the owner's stored
 * calendar zone. A GET travels a real HTTP server → the agent's plugin route
 * dispatcher → the registered personal-assistant routes → FinancesService →
 * FinancesRepository on a PGlite runtime. The owner's timezone fact
 * (America/Los_Angeles) must win over the agent's `TIMEZONE` setting
 * (Asia/Tokyo) at an instant where the two zones sit on different calendar
 * days. Only `Date` is faked so the clock is deterministic; no mocks
 * otherwise.
 */
import crypto from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import financesPlugin from "@elizaos/plugin-finances";
import { FinancesRepository } from "@elizaos/plugin-finances/db/finances-repository";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { tryHandleRuntimePluginRoute } from "../../../../packages/agent/src/api/runtime-plugin-routes.ts";
import { createLifeOpsTestRuntime } from "../../test/helpers/runtime.js";
import {
  createOwnerFactStore,
  registerOwnerFactStore,
  resolveOwnerFactStore,
} from "../lifeops/owner/fact-store.js";

// 03:30Z on March 3: still March 2 in Los Angeles, already March 3 in Tokyo.
const NOW = new Date("2026-03-03T03:30:00.000Z");
const DUE_TODAY_IN_LA = "2026-03-02";

let host: Awaited<ReturnType<typeof createLifeOpsTestRuntime>>;

beforeAll(async () => {
  host = await createLifeOpsTestRuntime({ plugins: [financesPlugin] });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
}, 180_000);

afterAll(async () => {
  vi.useRealTimers();
  await host?.cleanup();
});

it("classifies a bill due today for the owner as upcoming, not overdue", async () => {
  const runtime = host.runtime;
  runtime.setSetting("TIMEZONE", "Asia/Tokyo");
  registerOwnerFactStore(runtime, createOwnerFactStore(runtime));
  await resolveOwnerFactStore(runtime).update(
    { timezone: "America/Los_Angeles" },
    { source: "profile_save", recordedAt: "2026-02-01T00:00:00.000Z" },
  );
  const repository = new FinancesRepository(runtime);
  const createdAt = "2026-02-20T12:00:00.000Z";
  const sourceId = crypto.randomUUID();
  await repository.upsertPaymentSource({
    id: sourceId,
    agentId: runtime.agentId,
    kind: "email",
    label: "Gmail bills",
    institution: null,
    accountMask: null,
    status: "active",
    lastSyncedAt: null,
    transactionCount: 0,
    metadata: {},
    createdAt,
    updatedAt: createdAt,
  });
  const billId = crypto.randomUUID();
  await repository.insertPaymentTransaction({
    id: billId,
    agentId: runtime.agentId,
    sourceId,
    externalId: null,
    postedAt: createdAt,
    amountUsd: 84.5,
    direction: "debit",
    merchantRaw: "City Water",
    merchantNormalized: "city water",
    description: "March water bill",
    category: null,
    currency: "USD",
    metadata: { kind: "bill", dueDate: DUE_TODAY_IN_LA, confidence: 0.9 },
    createdAt,
  });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const handled = await tryHandleRuntimePluginRoute({
      req,
      res,
      url,
      pathname: url.pathname,
      method: req.method ?? "GET",
      runtime,
      isAuthorized: () => true,
    });
    if (!handled && !res.headersSent) {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("HTTP server omitted bound TCP address");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/lifeops/money/bills`,
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      bills: Array<{ id: string; dueDate: string | null; status: string }>;
    };
    expect(payload.bills.find((bill) => bill.id === billId)).toMatchObject({
      dueDate: DUE_TODAY_IN_LA,
      status: "upcoming",
    });
    expect(runtime.getRecentReportedErrors()).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}, 180_000);

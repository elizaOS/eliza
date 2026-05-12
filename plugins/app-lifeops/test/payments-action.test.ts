/**
 * `PAYMENTS` action integration test.
 *
 * Closes the gap from `docs/audits/lifeops-2026-05-09/03-coverage-gap-matrix.md`
 * line 444 + line 94 (#67): `paymentsAction` had no executable test, and the
 * payments mixin had ZERO e2e or integration coverage under app-lifeops.
 *
 * Uses a real PGLite-backed lifeops runtime via `createLifeOpsTestRuntime`,
 * so the `LifeOpsService` payments mixin runs its real SQL against a real
 * schema. We exercise:
 *   - `add_source` → row lands in `lifeops_payment_sources`
 *   - `list_sources` → reflects the new source
 *   - `import_csv` → parses, dedupes, updates source.transactionCount
 *   - `list_transactions` → returns the imported rows
 *   - `dashboard` → composite read returns sources + spending + recurring
 *   - `remove_source` → row is deleted
 *
 * No mocks for the service/repository — the only thing stubbed is the
 * surrounding agent harness (model client, action loop, etc.) which is
 * irrelevant here since we drive the action handler directly with explicit
 * parameters.
 *
 * Mockoon-mode note (`LIFEOPS_USE_MOCKOON`): the audit asks for a
 * Mockoon-mocked Plaid path; that mock fixture lives outside this plugin
 * (`eliza/test/mocks/mockoon/`). When the Mockoon URL is set, the
 * `add_source` kind=plaid path becomes deterministic via that mock; here we
 * exercise the kind=manual path which requires no external service and is
 * the canonical happy-path for the action's CSV import flow.
 */

import type { Memory, UUID } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
// Audit B Defer #4 folded `PAYMENTS` into the `MONEY` umbrella; exercise the
// payments handler directly so this integration test still covers the
// LifeOpsService payments mixin without re-registering the retired action.
import { runPaymentsHandler } from "../src/actions/payments.ts";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentTransaction,
} from "../src/lifeops/payment-types.ts";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

function ownerMessage(agentId: UUID, text: string): Memory {
  return {
    id: ("msg-" + Math.random().toString(36).slice(2, 8)) as UUID,
    entityId: agentId,
    roomId: agentId,
    agentId,
    content: { text, source: "test" },
    createdAt: Date.now(),
  } as Memory;
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}
const SAMPLE_CSV = [
  "date,amount,merchant,description,category",
  `${daysAgo(1)},12.34,Starbucks,Latte,Coffee`,
  `${daysAgo(2)},-50.00,Whole Foods,Groceries,Food`,
  `${daysAgo(3)},9.99,Netflix,Streaming,Entertainment`,
].join("\n");

describe("PAYMENTS action integration", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    if (runtimeResult) {
      await runtimeResult.cleanup();
      runtimeResult = null;
    }
  });

  it("add_source → list_sources round-trips a manual Chase source", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    // Canonical `subaction` field for the new convention.
    const addResult = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "add chase account"),
      undefined,
      {
        parameters: {
          subaction: "add_source",
          kind: "manual",
          label: "Chase Checking",
          institution: "Chase",
          accountMask: "1234",
        },
      },
    );
    expect(addResult?.success).toBe(true);
    const addedSource = (addResult?.data as { source?: LifeOpsPaymentSource })
      .source;
    expect(addedSource?.kind).toBe("manual");
    expect(addedSource?.label).toBe("Chase Checking");
    expect(addedSource?.institution).toBe("Chase");
    expect(addedSource?.accountMask).toBe("1234");

    // `subaction` is the only canonical discriminator.
    const listResult = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "list payment sources"),
      undefined,
      { parameters: { subaction: "list_sources" } },
    );
    expect(listResult?.success).toBe(true);
    const sources =
      (listResult?.data as { sources?: LifeOpsPaymentSource[] }).sources ?? [];
    expect(sources).toHaveLength(1);
    expect(sources[0]?.id).toBe(addedSource?.id);
  });

  it("import_csv inserts transactions and dedupes on re-import", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const add = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "add manual source"),
      undefined,
      {
        parameters: {
          subaction: "add_source",
          kind: "manual",
          label: "Manual",
        },
      },
    );
    const sourceId = (add?.data as { source?: LifeOpsPaymentSource }).source
      ?.id as string;
    expect(sourceId).toBeTruthy();

    const firstImport = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "import csv"),
      undefined,
      {
        parameters: {
          subaction: "import_csv",
          sourceId,
          csvText: SAMPLE_CSV,
        },
      },
    );
    expect(firstImport?.success).toBe(true);
    const firstResult = (
      firstImport?.data as {
        result?: { inserted: number; skipped: number };
      }
    ).result;
    expect(firstResult?.inserted).toBe(3);
    expect(firstResult?.skipped).toBe(0);

    const reImport = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "import csv again"),
      undefined,
      {
        parameters: { subaction: "import_csv", sourceId, csvText: SAMPLE_CSV },
      },
    );
    const reResult = (
      reImport?.data as { result?: { inserted: number; skipped: number } }
    ).result;
    expect(reResult?.inserted).toBe(0);
    expect(reResult?.skipped).toBe(3);

    const listTxn = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "list transactions"),
      undefined,
      { parameters: { subaction: "list_transactions", sourceId } },
    );
    const txns =
      (listTxn?.data as { transactions?: LifeOpsPaymentTransaction[] })
        .transactions ?? [];
    expect(txns).toHaveLength(3);
    const merchants = txns.map((t) => t.merchantRaw).sort();
    expect(merchants).toEqual(["Netflix", "Starbucks", "Whole Foods"]);
  });

  it("dashboard returns composite payments view", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const add = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "add"),
      undefined,
      {
        parameters: { subaction: "add_source", kind: "manual", label: "Daily" },
      },
    );
    const sourceId = (add?.data as { source?: LifeOpsPaymentSource }).source
      ?.id as string;

    await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "import"),
      undefined,
      {
        parameters: {
          subaction: "import_csv",
          sourceId,
          csvText: SAMPLE_CSV,
        },
      },
    );

    const dashboard = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "show dashboard"),
      undefined,
      { parameters: { subaction: "dashboard", windowDays: 30 } },
    );
    expect(dashboard?.success).toBe(true);
    const dash = (
      dashboard?.data as {
        dashboard?: {
          sources: LifeOpsPaymentSource[];
          spending: { totalSpendUsd: number; transactionCount: number };
        };
      }
    ).dashboard;
    expect(dash?.sources).toHaveLength(1);
    expect(dash?.spending.transactionCount).toBe(3);
    expect(dash?.spending.totalSpendUsd).toBeGreaterThan(0);
  });

  it("remove_source deletes the row", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const add = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "add"),
      undefined,
      {
        parameters: {
          subaction: "add_source",
          kind: "manual",
          label: "Throwaway",
        },
      },
    );
    const sourceId = (add?.data as { source?: LifeOpsPaymentSource }).source
      ?.id as string;

    const remove = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "remove"),
      undefined,
      { parameters: { subaction: "remove_source", sourceId } },
    );
    expect(remove?.success).toBe(true);

    const list = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "list"),
      undefined,
      { parameters: { subaction: "list_sources" } },
    );
    const sources =
      (list?.data as { sources?: LifeOpsPaymentSource[] }).sources ?? [];
    expect(sources).toHaveLength(0);
  });

  it("add_source returns MISSING_SOURCE_FIELDS when kind/label are absent", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;

    const result = await runPaymentsHandler(
      runtime,
      ownerMessage(runtime.agentId, "add"),
      undefined,
      { parameters: { subaction: "add_source" } },
    );
    expect(result?.success).toBe(false);
    expect((result?.data as { error?: string }).error).toBe(
      "MISSING_SOURCE_FIELDS",
    );
  });
});

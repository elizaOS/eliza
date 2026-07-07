/**
 * Regression coverage for the durable commitments/obligations ledger. The
 * extractor is deliberately conservative and deterministic here; live model
 * extraction trajectories belong to the scenario lane once credentials are
 * available.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCommitmentRegretAudit,
  createLifeOpsCommitmentLedgerRecord,
  extractCommitmentLedgerRecords,
  LifeOpsRepository,
} from "../src/lifeops/index.js";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "./helpers/runtime.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000001864";
const OBSERVED_AT = "2026-07-06T15:00:00.000Z";

describe("commitment ledger extraction and audit", () => {
  it("extracts a concrete sent-mail promise with a due date", () => {
    const rows = extractCommitmentLedgerRecords({
      agentId: AGENT_ID,
      source: "sent_mail",
      sourceKey: "gmail:msg-1",
      observedAt: OBSERVED_AT,
      counterparty: "Mira",
      text: "I'll send the deck Friday and include the pricing appendix.",
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source: "sent_mail",
      sourceKey: "gmail:msg-1",
      kind: "commitment",
      counterparty: "Mira",
      dueAt: "2026-07-10T17:00:00.000Z",
      status: "open",
      scheduledTaskId: null,
    });
    expect(rows[0]?.summary).toContain("send the deck Friday");
  });

  it("does not create rows for speculative chit-chat", () => {
    const rows = extractCommitmentLedgerRecords({
      agentId: AGENT_ID,
      source: "chat",
      sourceKey: "thread:loose",
      observedAt: OBSERVED_AT,
      text: "Yeah maybe sometime we could send something over.",
    });

    expect(rows).toHaveLength(0);
  });

  it("ranks orphaned near-term obligations ahead of tracked or completed rows", () => {
    const orphan = createLifeOpsCommitmentLedgerRecord({
      agentId: AGENT_ID,
      source: "sent_mail",
      sourceKey: "gmail:deck",
      kind: "commitment",
      summary: "I'll send the deck Friday",
      counterparty: "Mira",
      dueAt: "2026-07-10T17:00:00.000Z",
      confidence: 0.74,
      metadata: {},
      createdAt: "2026-07-06T15:00:00.000Z",
    });
    const tracked = createLifeOpsCommitmentLedgerRecord({
      agentId: AGENT_ID,
      source: "document",
      sourceKey: "contract:acme",
      kind: "renewal",
      summary: "Renewal notice for Acme contract",
      counterparty: "Acme",
      dueAt: "2026-07-12T17:00:00.000Z",
      confidence: 0.9,
      status: "tracked",
      scheduledTaskId: "st_acme_renewal",
      metadata: {},
      createdAt: "2026-07-06T16:00:00.000Z",
    });
    const completed = createLifeOpsCommitmentLedgerRecord({
      agentId: AGENT_ID,
      source: "chat",
      sourceKey: "thread:done",
      kind: "commitment",
      summary: "I will send the notes",
      counterparty: null,
      dueAt: "2026-07-07T17:00:00.000Z",
      confidence: 0.8,
      status: "completed",
      metadata: {},
      createdAt: "2026-07-06T17:00:00.000Z",
    });

    const audit = buildCommitmentRegretAudit([tracked, completed, orphan], {
      nowIso: "2026-07-09T12:00:00.000Z",
      horizonDays: 7,
    });

    expect(audit.items.map((item) => item.record.id)).toEqual([
      orphan.id,
      tracked.id,
    ]);
    expect(audit.items[0]?.reasons).toContain("no scheduled tracker");
    expect(audit.items[0]?.reasons).toContain("due inside audit horizon");
  });
});

describe("commitment ledger repository", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("persists extracted obligations through the LifeOps schema", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repo = new LifeOpsRepository(runtime);
    const record = extractCommitmentLedgerRecords({
      agentId: runtime.agentId,
      source: "sent_mail",
      sourceKey: "gmail:msg-commitment",
      observedAt: OBSERVED_AT,
      counterparty: "Mira",
      text: "I'll send the deck Friday and include the pricing appendix.",
    })[0];
    if (!record) {
      throw new Error("Expected commitment extraction to produce one record.");
    }

    await repo.upsertCommitmentLedgerRecord(record);

    const reloaded = new LifeOpsRepository(runtime);
    const rows = await reloaded.listCommitmentLedgerRecords(runtime.agentId, {
      statuses: ["open"],
      dueBeforeIso: "2026-07-11T00:00:00.000Z",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: record.id,
      source: "sent_mail",
      sourceKey: "gmail:msg-commitment",
      counterparty: "Mira",
      dueAt: "2026-07-10T17:00:00.000Z",
      scheduledTaskId: null,
    });

    await reloaded.upsertCommitmentLedgerRecord({
      ...record,
      status: "tracked",
      scheduledTaskId: "st_deck_followup",
      updatedAt: "2026-07-06T18:00:00.000Z",
    });

    const tracked = await reloaded.getCommitmentLedgerRecord(
      runtime.agentId,
      record.id,
    );
    expect(tracked).toMatchObject({
      status: "tracked",
      scheduledTaskId: "st_deck_followup",
    });
  });
});

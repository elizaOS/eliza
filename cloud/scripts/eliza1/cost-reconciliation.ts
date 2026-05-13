import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const DEFAULT_EVIDENCE_DIR = resolve(REPO_ROOT, "reports/eliza1-release-gates");

interface Args {
  organizationId?: string;
  provider?: string;
  model?: string;
  startDate: Date;
  endDate: Date;
  providerSpendTotal: number | null;
  maxDrift: number;
  evidenceDir: string;
}

interface BillingRecordRow {
  id: string;
  usage_record_id: string;
  reservation_transaction_id: string | null;
  settlement_transaction_ids: string[] | null;
  idempotency_key: string;
  usage_total_cost: string;
  ledger_total: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    startDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    endDate: new Date(),
    providerSpendTotal:
      process.env.ELIZA1_PROVIDER_SPEND_TOTAL === undefined
        ? null
        : Number(process.env.ELIZA1_PROVIDER_SPEND_TOTAL),
    maxDrift: Number(process.env.ELIZA1_COST_MAX_DRIFT ?? "0.01"),
    evidenceDir: process.env.ELIZA1_EVIDENCE_DIR || DEFAULT_EVIDENCE_DIR,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--organization-id") args.organizationId = next();
    else if (arg === "--provider") args.provider = next();
    else if (arg === "--model") args.model = next();
    else if (arg === "--start") args.startDate = new Date(next());
    else if (arg === "--end") args.endDate = new Date(next());
    else if (arg === "--provider-spend-total") args.providerSpendTotal = Number(next());
    else if (arg === "--max-drift") args.maxDrift = Number(next());
    else if (arg === "--evidence-dir") args.evidenceDir = resolve(next());
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: bun cloud/scripts/eliza1/cost-reconciliation.ts --provider vast --provider-spend-total N [options]",
          "",
          "Writes cost_reconciliation and billing_records evidence from DB-backed ai_billing_records.",
          "Required for pass: at least one billing record, usage/ledger drift within --max-drift, and provider spend supplied.",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.startDate.getTime())) throw new Error("--start is invalid");
  if (!Number.isFinite(args.endDate.getTime())) throw new Error("--end is invalid");
  if (args.endDate <= args.startDate) throw new Error("--end must be after --start");
  if (args.providerSpendTotal !== null && !Number.isFinite(args.providerSpendTotal)) {
    throw new Error("--provider-spend-total must be numeric");
  }
  if (!Number.isFinite(args.maxDrift) || args.maxDrift < 0) {
    throw new Error("--max-drift must be a non-negative number");
  }

  return args;
}

function timestampForFile(): string {
  return new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function writeEvidence(evidenceDir: string, gate: string, evidence: Record<string, unknown>) {
  mkdirSync(evidenceDir, { recursive: true });
  const file = resolve(evidenceDir, `${gate}-${timestampForFile()}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`[eliza1:${gate}] wrote ${relative(REPO_ROOT, file)} (${evidence.status})`);
}

function sum(records: readonly { usage_total_cost: string; ledger_total: string }) {
  return records.reduce(
    (acc, record) => {
      acc.usage += Number(record.usage_total_cost);
      acc.ledger += Number(record.ledger_total);
      return acc;
    },
    { usage: 0, ledger: 0 },
  );
}

async function listBillingRecords(args: Args): Promise<BillingRecordRow[]> {
  const databaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL or TEST_DATABASE_URL is required");
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const values: unknown[] = [args.startDate, args.endDate];
    const conditions = ["created_at >= $1", "created_at <= $2"];
    if (args.organizationId) {
      values.push(args.organizationId);
      conditions.push(`organization_id = $${values.length}`);
    }
    if (args.provider) {
      values.push(args.provider);
      conditions.push(`provider = $${values.length}`);
    }
    if (args.model) {
      values.push(args.model);
      conditions.push(`model = $${values.length}`);
    }

    const result = await pool.query<BillingRecordRow>(
      `
        SELECT
          id,
          usage_record_id,
          reservation_transaction_id,
          settlement_transaction_ids,
          idempotency_key,
          usage_total_cost,
          ledger_total
        FROM ai_billing_records
        WHERE ${conditions.join(" AND ")}
        ORDER BY created_at DESC
        LIMIT 10000
      `,
      values,
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let records: BillingRecordRow[];
  try {
    records = await listBillingRecords(args);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    writeEvidence(args.evidenceDir, "cost_reconciliation", {
      gate: "cost_reconciliation",
      status: "fail",
      completedAt: new Date().toISOString(),
      organizationId: args.organizationId ?? null,
      provider: args.provider ?? null,
      model: args.model ?? null,
      usageRecordsTotal: 0,
      ledgerTotal: 0,
      providerSpendTotal: args.providerSpendTotal,
      drift: null,
      error: reason,
      summary: `DB-backed cost reconciliation could not run: ${reason}`,
    });
    writeEvidence(args.evidenceDir, "billing_records", {
      gate: "billing_records",
      status: "fail",
      completedAt: new Date().toISOString(),
      usageRecordId: null,
      creditTransactionId: null,
      idempotencyKey: null,
      error: reason,
      summary: `DB-backed billing record check could not run: ${reason}`,
    });
    process.exitCode = 1;
    return;
  }

  const totals = sum(records);
  const usageRecordsTotal = Number(totals.usage.toFixed(6));
  const ledgerTotal = Number(totals.ledger.toFixed(6));
  const providerSpendTotal =
    args.providerSpendTotal === null ? null : Number(args.providerSpendTotal.toFixed(6));
  const drift = Number(Math.abs(usageRecordsTotal - ledgerTotal).toFixed(6));
  const hasProviderSpend = providerSpendTotal !== null && providerSpendTotal >= 0;
  const costStatus = records.length > 0 && hasProviderSpend && drift <= args.maxDrift;

  writeEvidence(args.evidenceDir, "cost_reconciliation", {
    gate: "cost_reconciliation",
    status: costStatus ? "pass" : "fail",
    completedAt: new Date().toISOString(),
    organizationId: args.organizationId ?? null,
    provider: args.provider ?? null,
    model: args.model ?? null,
    startDate: args.startDate.toISOString(),
    endDate: args.endDate.toISOString(),
    billingRecordCount: records.length,
    usageRecordsTotal,
    ledgerTotal,
    providerSpendTotal,
    drift,
    maxDrift: args.maxDrift,
    providerSpendRecorded: hasProviderSpend,
    summary: `${records.length} AI billing records; usage ${usageRecordsTotal}; ledger ${ledgerTotal}; provider spend ${providerSpendTotal ?? "missing"}; drift ${drift}`,
  });

  const latest = records[0];
  const settlementIds = Array.isArray(latest?.settlement_transaction_ids)
    ? latest.settlement_transaction_ids
    : [];
  const creditTransactionId = latest?.reservation_transaction_id ?? settlementIds[0] ?? null;
  const billingStatus = Boolean(
    latest?.usage_record_id && creditTransactionId && latest.idempotency_key,
  );

  writeEvidence(args.evidenceDir, "billing_records", {
    gate: "billing_records",
    status: billingStatus ? "pass" : "fail",
    completedAt: new Date().toISOString(),
    usageRecordId: latest?.usage_record_id ?? null,
    creditTransactionId,
    idempotencyKey: latest?.idempotency_key ?? null,
    billingRecordId: latest?.id ?? null,
    settlementTransactionIds: settlementIds,
    summary: billingStatus
      ? `AI billing record ${latest.id} joins usage ${latest.usage_record_id} to credit transaction ${creditTransactionId}`
      : "No complete AI billing record with usage, credit transaction, and idempotency key was found",
  });

  if (!costStatus || !billingStatus) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[eliza1:cost-reconciliation] ${error.message}`);
  process.exit(1);
});

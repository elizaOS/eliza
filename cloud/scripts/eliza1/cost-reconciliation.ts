import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aiBillingRecordsRepository } from "../../packages/db/repositories/ai-billing-records";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const records = await aiBillingRecordsRepository.listForReconciliation({
    organizationId: args.organizationId,
    provider: args.provider,
    model: args.model,
    startDate: args.startDate,
    endDate: args.endDate,
  });

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

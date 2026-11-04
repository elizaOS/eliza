/**
 * Scenario for inference-funding-budgets-legacy-replay.test.ts.
 *
 * Bundled and run under Node with LC_ALL=da_DK.UTF-8 (Node is the
 * full-ICU host stand-in; Bun ignores LC_ALL). Simulates a receipt
 * recorded before the v2 payload change on a Danish-collation host:
 * its stored request_digest is the digest of the v1 payload
 * (localeCompare allocation order). A retry of that consumption must
 * still replay — whether the caller signs the legacy bytes or the
 * current ones — while a receipt whose stored digest matches neither
 * byte set must still fail closed. Prints the three outcomes as JSON.
 * Environment (DATABASE_URL=<redacted>
 * budget signing secret) is supplied by the test process.
 */

import {
  budgetConsumptionLegacyPayload,
  budgetConsumptionPayload,
  budgetRequestDigest,
  signBudgetEffect,
} from "../../../lib/services/inference-funding-budget-protocol";
import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../client";
import { recordConsumption } from "../inference-funding-budgets";

const SECRET = "x".repeat(32);
const ORG = "71000000-0000-4000-8000-000000000001";
const AA = "aa000000-0000-4000-8000-000000000001";
const B0 = "b0000000-0000-4000-8000-000000000002";

const pglite = getPgliteClientForTests();
await pglite.exec(`
CREATE TABLE inference_funding_budget_grants (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  funding_reservation_id uuid NOT NULL,
  request_digest text NOT NULL,
  policy_generation text NOT NULL,
  policy_epoch text NOT NULL,
  amount numeric(16,6) NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  seal_sequence integer,
  seal_amount numeric(16,6),
  seal_signature text
);
CREATE TABLE inference_funding_budget_receipts (
  organization_id uuid NOT NULL,
  request_id text NOT NULL,
  request_digest text NOT NULL,
  amount numeric(16,6) NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inference_funding_budget_consumptions (
  organization_id uuid NOT NULL,
  request_id text NOT NULL,
  grant_id uuid NOT NULL,
  sequence integer NOT NULL,
  amount numeric(16,6) NOT NULL
);
`);

function consumption(requestId: string) {
  return {
    organizationId: ORG,
    requestId,
    amountMicros: "300",
    allocations: [
      { grantId: B0, sequence: 2, amountMicros: "200" },
      { grantId: AA, sequence: 1, amountMicros: "100" },
    ],
    metadata: {},
  };
}

async function seedReceipt(requestId: string, storedDigest: string) {
  await pglite.query(
    `INSERT INTO inference_funding_budget_receipts
       (organization_id, request_id, request_digest, amount, metadata)
     VALUES ($1, $2, $3, '300.000000', '{}')`,
    [ORG, requestId, storedDigest],
  );
}

async function attempt(requestId: string, payload: string) {
  const signature = await signBudgetEffect(payload, SECRET);
  try {
    const result = await recordConsumption({ ...consumption(requestId), signature });
    return { replayed: result.replayed };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// A receipt recorded under the v1 bytes on this (da-DK) host.
const legacyDigest = await budgetRequestDigest(
  budgetConsumptionLegacyPayload(consumption("req-legacy-1")),
);
await seedReceipt("req-legacy-1", legacyDigest);
const legacySigned = await attempt(
  "req-legacy-1",
  budgetConsumptionLegacyPayload(consumption("req-legacy-1")),
);
const currentSigned = await attempt(
  "req-legacy-1",
  budgetConsumptionPayload(consumption("req-legacy-1")),
);

// A receipt whose stored digest matches neither byte set still fails.
await seedReceipt("req-legacy-2", "f".repeat(64));
const mismatch = await attempt(
  "req-legacy-2",
  budgetConsumptionPayload(consumption("req-legacy-2")),
);

console.log(JSON.stringify({ legacySigned, currentSigned, mismatch }));
await closeDatabaseConnectionsForTests();

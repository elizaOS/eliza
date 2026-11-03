/**
 * Scenario for inference-funding-budgets-consumptions-order.test.ts.
 *
 * Bundled and run under Node with LC_ALL=da_DK.UTF-8 (Node is the
 * full-ICU host stand-in; Bun ignores LC_ALL). Seeds two open grants
 * whose ids separate code-unit order from Danish collation ("aa…"
 * collates as å, after "b0…"), records one signed consumption over
 * both, and prints the physical insertion order of the consumptions
 * rows as JSON. Environment (DATABASE_URL=pglite://memory and the
 * budget signing secret) is supplied by the test process.
 */

import {
  budgetConsumptionPayload,
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
for (const [id, amount] of [
  [AA, "100.000000"],
  [B0, "200.000000"],
] as const) {
  await pglite.query(
    `INSERT INTO inference_funding_budget_grants
       (id, organization_id, funding_reservation_id, request_digest, policy_generation, policy_epoch, amount, expires_at)
     VALUES ($1, $2, gen_random_uuid(), $3, '1', '1', $4, now() + interval '1 hour')`,
    [id, ORG, "c".repeat(64), amount],
  );
}

const unsigned = {
  organizationId: ORG,
  requestId: "req-order-1",
  amountMicros: "300",
  allocations: [
    { grantId: B0, sequence: 2, amountMicros: "200" },
    { grantId: AA, sequence: 1, amountMicros: "100" },
  ],
  metadata: {},
};
const payload = budgetConsumptionPayload(unsigned);
const signature = await signBudgetEffect(payload, SECRET);
await recordConsumption({ ...unsigned, signature });
const { rows } = await pglite.query<{ grant_id: string }>(
  "SELECT grant_id FROM inference_funding_budget_consumptions ORDER BY ctid",
);
console.log(JSON.stringify(rows.map((row) => row.grant_id)));
await closeDatabaseConnectionsForTests();

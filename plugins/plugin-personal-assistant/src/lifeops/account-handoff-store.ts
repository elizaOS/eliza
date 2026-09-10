/**
 * Persists an owner's exact account-handoff review and ordered checkpoints.
 * Conditional writes prevent stale tabs from replacing an active review or
 * advancing a step twice. Saved receipt values cannot be overwritten by later
 * steps. Receipts survive process restarts; connector effects
 * must be verified by the coordinator before it advances their checkpoint.
 */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  executeRawSql,
  type LifeOpsDatabaseContext,
  sqlJson,
  sqlText,
} from "./sql.js";

const identity = z
  .string()
  .min(1)
  .refine((value) => value === value.trim() && !value.includes("\0"));
const googleAccount = z
  .object({
    grantId: identity,
    connectorAccountId: identity,
    email: z.email(),
  })
  .strict();
const calendar = z
  .object({
    grantId: identity,
    connectorAccountId: identity,
    calendarId: identity,
  })
  .strict();

export const accountHandoffReviewSchema = z
  .object({
    previous: googleAccount,
    replacement: googleAccount,
    readCalendars: z.array(calendar),
    writeCalendar: calendar.nullable(),
    messageDestinations: z.array(
      z
        .object({
          channel: z.enum(["imessage", "telegram", "discord", "email"]),
          connectorAccountId: identity,
          recipientId: identity,
        })
        .strict(),
    ),
    importedData: z.enum(["retain", "remove_previous_account_imports"]),
    retireApprovalIds: z.array(identity),
  })
  .strict()
  .superRefine((review, ctx) => {
    if (
      review.previous.grantId === review.replacement.grantId ||
      review.previous.connectorAccountId ===
        review.replacement.connectorAccountId ||
      review.previous.email.toLowerCase() ===
        review.replacement.email.toLowerCase()
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Choose different previous and replacement accounts",
      });
    }
    for (const selected of [
      ...review.readCalendars,
      ...(review.writeCalendar ? [review.writeCalendar] : []),
    ]) {
      if (
        selected.grantId !== review.replacement.grantId ||
        selected.connectorAccountId !== review.replacement.connectorAccountId
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Reviewed calendars must belong to the replacement account",
        });
      }
    }
  });

const phaseSchema = z.enum([
  "reviewed",
  "pausing",
  "draining",
  "retiring_approvals",
  "applying_mappings",
  "verifying_replacement",
  "disconnecting_previous",
  "disposing_imports",
  "resuming",
  "completed",
  "cancelled",
]);
export type AccountHandoffReview = z.infer<typeof accountHandoffReviewSchema>;
export type AccountHandoffPhase = z.infer<typeof phaseSchema>;
const receiptSchema = z.record(z.string(), z.json());
type AccountHandoffReceipt = z.infer<typeof receiptSchema>;

export interface AccountHandoffRecord {
  operationId: string;
  revision: number;
  phase: AccountHandoffPhase;
  review: AccountHandoffReview;
  receipt: AccountHandoffReceipt;
}
const nextPhase: Partial<Record<AccountHandoffPhase, AccountHandoffPhase>> = {
  reviewed: "pausing",
  pausing: "draining",
  draining: "retiring_approvals",
  retiring_approvals: "applying_mappings",
  applying_mappings: "verifying_replacement",
  verifying_replacement: "disconnecting_previous",
  disconnecting_previous: "disposing_imports",
  disposing_imports: "resuming",
  resuming: "completed",
};

function decode(row: Record<string, unknown>): AccountHandoffRecord {
  return {
    operationId: identity.parse(row.operation_id),
    revision: z.number().int().nonnegative().parse(row.revision),
    phase: phaseSchema.parse(row.phase),
    review: accountHandoffReviewSchema.parse(
      JSON.parse(z.string().parse(row.review_json)),
    ),
    receipt: receiptSchema.parse(
      JSON.parse(z.string().parse(row.receipt_json)),
    ),
  };
}

export class AccountHandoffStore {
  constructor(
    private readonly db: LifeOpsDatabaseContext,
    private readonly ownerEntityId: string,
  ) {
    identity.parse(ownerEntityId);
  }

  private scope(): string {
    return `agent_id = ${sqlText(this.db.agentId)} AND owner_entity_id = ${sqlText(this.ownerEntityId)}`;
  }

  async read(operationId: string): Promise<AccountHandoffRecord | null> {
    const rows = await executeRawSql(
      this.db,
      `SELECT * FROM app_lifeops.life_account_handoffs
      WHERE ${this.scope()} AND operation_id = ${sqlText(identity.parse(operationId))}`,
    );
    return rows.length ? decode(rows[0]) : null;
  }

  async active(): Promise<AccountHandoffRecord | null> {
    const rows = await executeRawSql(
      this.db,
      `SELECT * FROM app_lifeops.life_account_handoffs
      WHERE ${this.scope()} AND phase NOT IN ('completed', 'cancelled')`,
    );
    return rows.length ? decode(rows[0]) : null;
  }

  async review(
    operationId: string,
    input: AccountHandoffReview,
  ): Promise<AccountHandoffRecord> {
    identity.parse(operationId);
    const review = accountHandoffReviewSchema.parse(input);
    const rows = await executeRawSql(
      this.db,
      `INSERT INTO app_lifeops.life_account_handoffs
      (agent_id, owner_entity_id, operation_id, review_json)
      VALUES (${sqlText(this.db.agentId)}, ${sqlText(this.ownerEntityId)}, ${sqlText(operationId)}, ${sqlJson(review)})
      ON CONFLICT DO NOTHING RETURNING *`,
    );
    if (rows.length) return decode(rows[0]);
    const existing = await this.read(operationId);
    if (existing && JSON.stringify(existing.review) === JSON.stringify(review))
      return existing;
    throw this.conflict();
  }

  async advance(input: {
    operationId: string;
    expectedRevision: number;
    expectedPhase: AccountHandoffPhase;
    phase: AccountHandoffPhase;
    receipt: AccountHandoffReceipt;
  }): Promise<AccountHandoffRecord> {
    identity.parse(input.operationId);
    z.number().int().min(0).max(2_147_483_646).parse(input.expectedRevision);
    if (
      nextPhase[input.expectedPhase] !== input.phase &&
      !(input.expectedPhase === "reviewed" && input.phase === "cancelled")
    ) {
      throw new ElizaError("Account handoff steps must complete in order", {
        code: "ACCOUNT_HANDOFF_STEP_INVALID",
      });
    }
    const rows = await executeRawSql(
      this.db,
      `UPDATE app_lifeops.life_account_handoffs
      SET phase = ${sqlText(input.phase)}, revision = revision + 1,
        receipt_json = (receipt_json::jsonb || ${sqlJson(receiptSchema.parse(input.receipt))}::jsonb)::text, updated_at = NOW()
      WHERE ${this.scope()} AND operation_id = ${sqlText(input.operationId)}
        AND revision = ${input.expectedRevision} AND phase = ${sqlText(input.expectedPhase)}
        AND NOT EXISTS (
          SELECT 1 FROM jsonb_each(${sqlJson(receiptSchema.parse(input.receipt))}::jsonb) AS incoming
          JOIN jsonb_each(receipt_json::jsonb) AS saved USING (key)
          WHERE incoming.value IS DISTINCT FROM saved.value
        ) RETURNING *`,
    );
    if (rows.length) return decode(rows[0]);
    throw this.conflict();
  }

  private conflict(): ElizaError {
    return new ElizaError(
      "An account handoff changed or is already active. Reload its saved review before continuing.",
      {
        code: "ACCOUNT_HANDOFF_CONFLICT",
      },
    );
  }
}

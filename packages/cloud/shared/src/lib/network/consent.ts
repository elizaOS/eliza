/**
 * Durable copy of The Network's consent ledger (`network.consent_ledger`).
 * The gateway's Redis ledger is the enforcement fast path; this append-only
 * table is the audit record. Appends are idempotent per
 * (channel, provider message id), so gateway retries never double-record.
 */

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { NetworkSqlExecutor } from "./member-store";

type Executor = NetworkSqlExecutor | (() => Promise<NetworkSqlExecutor>);

export const networkConsentEntrySchema = z.object({
  project: z.literal("network"),
  channel: z.enum(["twilio", "blooio", "telegram", "whatsapp", "web"]),
  address: z.string().trim().min(3).max(200),
  state: z.enum(["opted_in", "opted_out"]),
  source: z.string().trim().min(1).max(120),
  providerMessageId: z.string().trim().min(1).max(200),
  at: z.string().datetime(),
});

export type NetworkConsentEntryInput = z.infer<typeof networkConsentEntrySchema>;

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? rows : [];
}

export function createPostgresNetworkConsentWriter(executor: Executor) {
  const db = typeof executor === "function" ? executor : async () => executor;
  return {
    async append(entry: NetworkConsentEntryInput): Promise<{ recorded: boolean }> {
      const inserted = rowsOf(
        await (await db()).execute(sql`
          INSERT INTO "network"."consent_ledger"
            ("channel", "address", "state", "source", "provider_message_id", "recorded_at")
          VALUES (${entry.channel}, ${entry.address.trim().toLowerCase()}, ${entry.state},
                  ${entry.source}, ${entry.providerMessageId}, ${entry.at}::timestamptz)
          ON CONFLICT ("channel", "provider_message_id") WHERE "provider_message_id" IS NOT NULL
          DO NOTHING
          RETURNING "id"
        `),
      );
      return { recorded: inserted.length > 0 };
    },
  };
}

export const networkConsentWriter = createPostgresNetworkConsentWriter(
  async () => (await import("../../db/client")).dbWrite as unknown as NetworkSqlExecutor,
);

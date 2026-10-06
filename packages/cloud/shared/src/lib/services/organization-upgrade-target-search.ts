/** Complete read-only traversal for original-period applied target evidence. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { projectHistoricalUpgradeTarget } from "./organization-upgrade-historical-target";

type Context = Omit<Parameters<typeof projectHistoricalUpgradeTarget>[0], "raw">;
export interface UpgradeTargetEventReader {
  list(
    input: {
      types: string[];
      limit: 100;
      created: { gte: number; lte: number };
      starting_after?: string;
    },
    options: { apiVersion: "2024-11-20.acacia" },
  ): Promise<unknown>;
}
const pageSchema = z.object({
  object: z.literal("list"),
  has_more: z.boolean(),
  data: z.array(z.unknown()),
});
const idSchema = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9]+$/) });
const candidateSchema = z.object({
  data: z.object({
    object: z.object({ id: z.string(), latest_invoice: z.unknown() }).passthrough(),
  }),
});
function reject(reason: string): never {
  throw new ElizaError("Original historical target requires complete authenticated evidence", {
    code: "SUBSCRIPTION_UPGRADE_TARGET_RECOVERY_UNAVAILABLE",
    context: { reason },
  });
}
export async function findOriginalUpgradeTargetEvent(
  input: Context & { reader: UpgradeTargetEventReader },
) {
  const observed = Math.floor(input.observedAt.getTime() / 1000),
    start = input.review.prorationDate;
  const end = Math.min(observed, Math.ceil(input.source.current_period_end.getTime() / 1000) - 1);
  if (
    !Number.isSafeInteger(observed) ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start <= 0 ||
    start > end
  )
    reject("invalid_search_window");
  if (observed - start >= 30 * 86400) reject("event_history_expired");
  const seen = new Set<string>();
  let cursor: string | undefined;
  let match:
    | { raw: unknown; evidence: ReturnType<typeof projectHistoricalUpgradeTarget> }
    | undefined;
  for (;;) {
    const parsed = pageSchema.safeParse(
      await input.reader.list(
        {
          types: ["customer.subscription.updated", "customer.subscription.pending_update_applied"],
          limit: 100,
          created: { gte: start, lte: end },
          ...(cursor ? { starting_after: cursor } : {}),
        },
        { apiVersion: "2024-11-20.acacia" },
      ),
    );
    if (!parsed.success) reject("invalid_event_page");
    const page = parsed.data;
    if (page.data.length > 100 || (page.has_more && page.data.length === 0))
      reject("incomplete_event_page");
    for (const raw of page.data) {
      const id = idSchema.safeParse(raw);
      if (!id.success || seen.has(id.data.id)) reject("repeated_or_invalid_event_cursor");
      cursor = id.data.id;
      seen.add(cursor);
      const candidate = candidateSchema.safeParse(raw);
      if (
        !candidate.success ||
        candidate.data.data.object.id !== input.origin.subscriptionId ||
        candidate.data.data.object.latest_invoice !== input.origin.invoiceId
      )
        continue;
      const object = candidate.data.data.object;
      // A pending/old-plan update is not applied-target evidence; an applied-looking candidate must validate completely.
      if (object.pending_update !== null && object.pending_update !== undefined) continue;
      const oldPrice = z
        .object({
          items: z.object({ data: z.array(z.object({ price: z.object({ id: z.string() }) })) }),
        })
        .safeParse(object);
      if (oldPrice.success && oldPrice.data.items.data[0]?.price.id === input.binding.sourcePriceId)
        continue;
      const evidence = projectHistoricalUpgradeTarget({ ...input, raw });
      if (!match || evidence.eventCreatedAt < match.evidence.eventCreatedAt)
        match = { raw, evidence };
    }
    if (!page.has_more) {
      if (!match) reject("historical_target_missing");
      return match;
    }
  }
}

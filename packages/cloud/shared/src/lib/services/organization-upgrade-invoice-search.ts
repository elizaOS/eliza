/** Read-only attribution search over authenticated platform Stripe event pages. */
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import { projectAuthenticatedUpgradeInvoiceOrigin } from "./organization-upgrade-invoice-origin";

type Request = Parameters<typeof projectAuthenticatedUpgradeInvoiceOrigin>[0]["originalRequest"];
export interface UpgradeOriginEventReader {
  list(
    input: {
      type: "invoice.created";
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
const cursorSchema = z.object({ id: z.string().regex(/^evt_[A-Za-z0-9]+$/) });
const attributionSchema = z.object({ request: z.object({ idempotency_key: z.string() }) });
function unavailable(reason: string): never {
  throw new ElizaError(
    "Original upgrade invoice recovery requires complete authenticated attribution",
    { code: "SUBSCRIPTION_UPGRADE_INVOICE_RECOVERY_UNAVAILABLE", context: { reason } },
  );
}
/** Caller supplies an authenticated platform reader, never renderer-supplied event JSON.
 * Complete the fixed-window traversal before selecting an origin; an early match
 * cannot hide a conflicting invoice on a later page. Exhaustion never permits POST.
 */
export async function findOriginalUpgradeInvoiceEvent(input: {
  reader: UpgradeOriginEventReader;
  originalRequest: Request;
  observedAt: Date;
}) {
  const end = Math.floor(input.observedAt.getTime() / 1000),
    start = input.originalRequest.prorationDate;
  if (!Number.isSafeInteger(end) || !Number.isSafeInteger(start) || start <= 0 || start > end)
    unavailable("invalid_search_window");
  if (end - start >= 30 * 86400) unavailable("event_history_expired");
  const seen = new Set<string>();
  let cursor: string | undefined;
  let match:
    | { raw: unknown; origin: ReturnType<typeof projectAuthenticatedUpgradeInvoiceOrigin> }
    | undefined;
  for (;;) {
    const parsed = pageSchema.safeParse(
      await input.reader.list(
        {
          type: "invoice.created",
          limit: 100,
          created: { gte: start, lte: end },
          ...(cursor ? { starting_after: cursor } : {}),
        },
        { apiVersion: "2024-11-20.acacia" },
      ),
    );
    if (!parsed.success) unavailable("invalid_event_page");
    const page = parsed.data;
    if (page.data.length > 100 || (page.has_more && page.data.length === 0))
      unavailable("incomplete_event_page");
    for (const raw of page.data) {
      const id = cursorSchema.safeParse(raw);
      if (!id.success || seen.has(id.data.id)) unavailable("repeated_or_invalid_event_cursor");
      seen.add(id.data.id);
      cursor = id.data.id;
      const attributed = attributionSchema.safeParse(raw);
      if (
        !attributed.success ||
        attributed.data.request.idempotency_key !== input.originalRequest.providerIdempotencyKey
      )
        continue;
      const origin = projectAuthenticatedUpgradeInvoiceOrigin({
        raw,
        originalRequest: input.originalRequest,
        observedAt: input.observedAt,
      });
      if (
        match &&
        (match.origin.invoiceId !== origin.invoiceId ||
          match.origin.providerRequestId !== origin.providerRequestId)
      )
        unavailable("conflicting_original_invoice");
      match ??= { raw, origin };
    }
    if (!page.has_more) {
      if (!match) unavailable("original_attribution_missing");
      return match;
    }
  }
}

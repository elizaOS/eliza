/** Complete read-only traversal of authenticated platform event history for one original request. */
import { z } from "zod";
export interface OriginalStripeEventReader<TEvent extends string> {
  list(
    input: {
      type: TEvent;
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
export async function findUniqueOriginalStripeEvent<TEvent extends string, T>(input: {
  reader: OriginalStripeEventReader<TEvent>;
  eventType: TEvent;
  startedAt: Date;
  observedAt: Date;
  providerIdempotencyKey: string;
  project: (raw: unknown) => { value: T; identity: string };
  unavailable: (reason: string) => never;
}) {
  const start = Math.floor(input.startedAt.getTime() / 1000),
    end = Math.floor(input.observedAt.getTime() / 1000);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    input.startedAt > input.observedAt
  )
    input.unavailable("invalid_search_window");
  if (end - start >= 30 * 86400) input.unavailable("event_history_expired");
  if (!input.providerIdempotencyKey) input.unavailable("original_request_missing");
  const seen = new Set<string>();
  let cursor: string | undefined;
  let match: { raw: unknown; value: T; identity: string } | undefined;
  for (;;) {
    const parsed = pageSchema.safeParse(
      await input.reader.list(
        {
          type: input.eventType,
          limit: 100,
          created: { gte: start, lte: end },
          ...(cursor ? { starting_after: cursor } : {}),
        },
        { apiVersion: "2024-11-20.acacia" },
      ),
    );
    if (!parsed.success) input.unavailable("invalid_event_page");
    const page = parsed.data;
    if (page.data.length > 100 || (page.has_more && page.data.length === 0))
      input.unavailable("incomplete_event_page");
    for (const raw of page.data) {
      const id = cursorSchema.safeParse(raw);
      if (!id.success || seen.has(id.data.id))
        input.unavailable("repeated_or_invalid_event_cursor");
      seen.add(id.data.id);
      cursor = id.data.id;
      const attribution = attributionSchema.safeParse(raw);
      if (
        !attribution.success ||
        attribution.data.request.idempotency_key !== input.providerIdempotencyKey
      )
        continue;
      const projected = input.project(raw);
      if (match && match.identity !== projected.identity)
        input.unavailable("conflicting_original_event");
      match ??= { raw, ...projected };
    }
    if (!page.has_more) {
      if (!match) input.unavailable("original_attribution_missing");
      return { raw: match.raw, value: match.value };
    }
  }
}

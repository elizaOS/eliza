import { type Context, type Env, Hono } from "hono";
import { z } from "zod";
import {
  CalendarSyncError,
  type CalendarSyncOwner,
  type ManagedCalendarSyncProvider,
} from "./calendar-sync-provider";

const calendarSelection = { grantId: z.string().uuid(), calendarId: z.string().min(1).max(1024) };
const selected = { ...calendarSelection, accountId: z.string().min(1).max(2048) };
const querySchema = z
  .object({
    ...selected,
    eventId: z.string().min(1).max(1024).optional(),
    idempotencyKey: z.string().min(1).max(2048).optional(),
  })
  .strict();
const capSchema = z.object(calendarSelection).strict();
const createSchema = z
  .object({
    ...selected,
    idempotencyKey: z.string().min(1).max(2048),
    event: z.record(z.string(), z.unknown()),
  })
  .strict();
const updateSchema = z
  .object({
    ...selected,
    eventId: z.string().min(1).max(1024),
    expectedEtag: z.string().min(1).max(1024),
    event: z.record(z.string(), z.unknown()),
  })
  .strict();
const deleteSchema = z
  .object({
    ...selected,
    eventId: z.string().min(1).max(1024),
    expectedEtag: z.string().min(1).max(1024),
  })
  .strict();
const invalid = () =>
  new CalendarSyncError(
    400,
    "CALENDAR_SYNC_INVALID",
    "not_accepted",
    "Review the exact Calendar operation fields.",
  );
async function query<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  // HTTP transports may represent Content-Length: 0 as an empty stream on
  // DELETE. Reject actual bytes, not the existence of the transport stream.
  if (request.body) {
    const reader = request.body.getReader();
    try {
      if (!(await reader.read()).done) throw invalid();
    } finally {
      await reader.cancel();
    }
  }
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].length !== new Set(params.keys()).size) throw invalid();
  const parsed = schema.safeParse(Object.fromEntries(params));
  if (!parsed.success) throw invalid();
  return parsed.data;
}
async function body<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (
    new URL(request.url).search ||
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    throw invalid();
  const reader = request.body?.getReader();
  if (!reader) throw invalid();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 256 * 1024)
        throw new CalendarSyncError(
          413,
          "CALENDAR_SYNC_TOO_LARGE",
          "not_accepted",
          "Calendar request exceeds its explicit size limit.",
        );
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw invalid();
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
/** Owner auth is completed before reading an untrusted body; tokens never enter the response. */
export function createCalendarSyncRoutes<E extends Env>(dependencies: {
  provider: Pick<
    ManagedCalendarSyncProvider,
    "capabilities" | "get" | "create" | "update" | "delete"
  >;
  authenticate(context: Context<E>): Promise<{ organizationId: string; userId: string }>;
  onError?(error: Error, context: Context<E>): Response | Promise<Response>;
}) {
  const app = new Hono<E>();
  app.onError((error, c) =>
    error instanceof CalendarSyncError
      ? c.json({ error: error.message, code: error.code, outcome: error.outcome }, error.status)
      : dependencies.onError
        ? dependencies.onError(error, c)
        : c.json(
            {
              error: "Calendar sync is unavailable.",
              code: "CALENDAR_SYNC_UNAVAILABLE",
              outcome: "unknown",
            },
            503,
          ),
  );
  const owner = (
    identity: { organizationId: string; userId: string },
    selection: { grantId: string; accountId?: string },
    c: Context<E>,
  ): CalendarSyncOwner => ({
    organizationId: identity.organizationId,
    userId: identity.userId,
    grantId: selection.grantId,
    accountId: selection.accountId,
    signal: c.req.raw.signal,
  });
  app.get("/capabilities", async (c) => {
    const identity = await dependencies.authenticate(c),
      input = await query(c.req.raw, capSchema);
    return c.json(
      await dependencies.provider.capabilities(owner(identity, input, c), input.calendarId),
    );
  });
  app.get("/event", async (c) => {
    const identity = await dependencies.authenticate(c),
      input = await query(c.req.raw, querySchema);
    return c.json({
      version: 1,
      calendarId: input.calendarId,
      event: await dependencies.provider.get(owner(identity, input, c), input.calendarId, {
        eventId: input.eventId,
        idempotencyKey: input.idempotencyKey,
      }),
      providerExactlyOnce: false,
    });
  });
  app.post("/event", async (c) => {
    const identity = await dependencies.authenticate(c),
      input = await body(c.req.raw, createSchema);
    return c.json(
      {
        version: 1,
        calendarId: input.calendarId,
        event: await dependencies.provider.create(
          owner(identity, input, c),
          input.calendarId,
          input.idempotencyKey,
          input.event,
        ),
        providerExactlyOnce: false,
      },
      201,
    );
  });
  app.patch("/event", async (c) => {
    const identity = await dependencies.authenticate(c),
      input = await body(c.req.raw, updateSchema);
    return c.json({
      version: 1,
      calendarId: input.calendarId,
      event: await dependencies.provider.update(
        owner(identity, input, c),
        input.calendarId,
        input.eventId,
        input.expectedEtag,
        input.event,
      ),
      providerExactlyOnce: false,
    });
  });
  app.delete("/event", async (c) => {
    const identity = await dependencies.authenticate(c),
      input = await query(c.req.raw, deleteSchema);
    return c.json({
      version: 1,
      calendarId: input.calendarId,
      ...(await dependencies.provider.delete(
        owner(identity, input, c),
        input.calendarId,
        input.eventId,
        input.expectedEtag,
      )),
      providerExactlyOnce: false,
    });
  });
  return app;
}

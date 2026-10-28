/** Explicit private host calendar reads. No provider credentials or mutation route. */
import type {
  LifeOpsCalendarFeed,
  LifeOpsCalendarSummary,
} from "@elizaos/contracts";
import { ElizaError } from "@elizaos/core";

const fail = () =>
  new ElizaError(
    "The managed owner Calendar connection could not be verified.",
    { code: "MANAGED_CALENDAR_READ_UNAVAILABLE" },
  );
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const scoped = (v: unknown): v is string =>
  typeof v === "string" && /^alpha-google:[a-f0-9]{64}$/.test(v);

const MANAGED_CALENDAR_BROKER_GRANT_ID = "alpha-google:broker";

export function managedCalendarPlaceholder(
  grantId?: string,
): LifeOpsCalendarSummary {
  const resolvedGrantId = scoped(grantId)
    ? grantId
    : MANAGED_CALENDAR_BROKER_GRANT_ID;
  return {
    provider: "google",
    side: "owner",
    grantId: resolvedGrantId,
    connectorAccountId: resolvedGrantId,
    accountEmail: null,
    calendarId: "all",
    summary: "Managed Google Calendar",
    description: null,
    primary: false,
    accessRole: "reader",
    backgroundColor: null,
    foregroundColor: null,
    timeZone: null,
    selected: true,
    includeInFeed: true,
    selectionVersion: 0,
  };
}

export function createManagedCalendarRead(
  env: NodeJS.ProcessEnv,
  request: typeof fetch,
) {
  const endpoint = env.ELIZA_MANAGED_CALENDAR_READ_BROKER;
  if (!endpoint) return undefined;
  const url = new URL(endpoint),
    token = env.ELIZA_API_TOKEN;
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.pathname !== "/__alpha-owner-gmail" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    !token ||
    !/^[A-Za-z0-9_-]{64}$/.test(token)
  )
    throw fail();
  async function call(calendar: object): Promise<Record<string, unknown>> {
    const r = await request(url, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ calendar }),
    });
    if (!r.ok || !r.body) {
      await r.body?.cancel();
      throw fail();
    }
    const reader = r.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) throw fail();
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(value)) throw fail();
    return value;
  }
  return {
    mutation: (input: Record<string, unknown>) => call(input),
    async writeCapabilities(grantId: string, calendarId: string) {
      if (!scoped(grantId) || !calendarId)
        throw Error("Choose the exact connected Calendar");
      const c = await call({
        operation: "write-capabilities",
        grantId,
        calendarId,
      });
      if (
        c.version !== 1 ||
        c.grantId !== grantId ||
        c.calendarId !== calendarId ||
        typeof c.accountId !== "string" ||
        c.read !== true ||
        c.write !== true ||
        c.idempotentCreate !== true ||
        c.conditionalWrites !== true ||
        c.providerExactlyOnce !== false
      )
        throw Error("Calendar write access could not be verified");
      return c as Record<string, unknown> & { accountId: string };
    },
    acceptsGrantId: (grantId?: string) => !grantId || scoped(grantId),
    owns: (calendar: LifeOpsCalendarSummary) => scoped(calendar.grantId),
    async sources(): Promise<LifeOpsCalendarSummary[]> {
      const { calendars } = await call({ operation: "sources" });
      if (
        !Array.isArray(calendars) ||
        calendars.length > 1000 ||
        !calendars.every(
          (c) =>
            record(c) &&
            c.provider === "google" &&
            c.side === "owner" &&
            scoped(c.grantId) &&
            c.connectorAccountId === c.grantId &&
            typeof c.calendarId === "string" &&
            typeof c.summary === "string" &&
            ["reader", "writer", "owner"].includes(String(c.accessRole)),
        )
      )
        throw fail();
      return calendars as LifeOpsCalendarSummary[];
    },
    async feed(
      calendar: LifeOpsCalendarSummary,
      timeMin: string,
      timeMax: string,
      timeZone: string,
      agentId: string,
    ): Promise<LifeOpsCalendarFeed> {
      if (!scoped(calendar.grantId)) throw fail();
      const { feed } = await call({
        operation: "feed",
        grantId: calendar.grantId,
        calendarId: calendar.calendarId,
        timeMin,
        timeMax,
        timeZone,
      });
      if (
        !record(feed) ||
        feed.calendarId !== calendar.calendarId ||
        feed.state !== "complete" ||
        feed.source !== "synced" ||
        feed.timeMin !== timeMin ||
        feed.timeMax !== timeMax ||
        !Array.isArray(feed.events) ||
        !Array.isArray(feed.sources) ||
        feed.sources.length !== 1 ||
        typeof feed.syncedAt !== "string" ||
        !Number.isFinite(Date.parse(feed.syncedAt))
      )
        throw fail();
      const health = feed.sources[0];
      if (
        !record(health) ||
        !record(health.key) ||
        health.key.grantId !== calendar.grantId ||
        health.key.calendarId !== calendar.calendarId ||
        health.key.side !== "owner" ||
        health.key.provider !== "google" ||
        health.status !== "fresh"
      )
        throw fail();
      for (const event of feed.events)
        if (
          !record(event) ||
          event.provider !== "google" ||
          event.side !== "owner" ||
          event.grantId !== calendar.grantId ||
          event.calendarId !== calendar.calendarId ||
          typeof event.id !== "string" ||
          typeof event.title !== "string" ||
          typeof event.startAt !== "string" ||
          typeof event.endAt !== "string" ||
          !Number.isFinite(Date.parse(event.startAt)) ||
          !Number.isFinite(Date.parse(event.endAt))
        )
          throw fail();
      const result = feed as unknown as LifeOpsCalendarFeed;
      return {
        ...result,
        events: result.events.map((event) => ({ ...event, agentId })),
      };
    },
  };
}

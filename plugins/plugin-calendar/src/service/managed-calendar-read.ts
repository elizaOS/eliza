/** Explicit private host calendar reads. No provider credentials or mutation route. */
import type {
  CalendarReadBrokerDiagnostic,
  LifeOpsCalendarFeed,
  LifeOpsCalendarSourceError,
  LifeOpsCalendarSummary,
} from "@elizaos/contracts";
import { calendarReadBrokerDiagnosticHeader } from "@elizaos/contracts";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";

const managedGoogleConnectionId = z.uuid();

type ReadDiagnostic = NonNullable<LifeOpsCalendarSourceError["diagnostic"]>;
type ReadAttempt = {
  operation: ReadDiagnostic["operation"];
  httpStatus: number | null;
  broker?: CalendarReadBrokerDiagnostic;
};
const diagnosticStages = {
  HTTP_STATUS: "http",
  BODY_MISSING: "body",
  BODY_LIMIT: "body",
  RESPONSE_NOT_OBJECT: "schema",
  SOURCES_SCHEMA_INVALID: "schema",
  REQUEST_SOURCE_INVALID: "schema",
  FEED_SCHEMA_INVALID: "schema",
  SOURCE_HEALTH_INVALID: "schema",
  EVENT_SCHEMA_INVALID: "schema",
} as const;
// A versioned key survives separately bundled copies, like ElizaError's brand.
// Values remain owned by current-call objects, never a global store, persisted
// data, public error context or source-access authority.
const diagnosticKey = Symbol.for("eliza.calendar.managed-read-diagnostic.v1");

const fail = (attempt?: ReadAttempt, code?: ReadDiagnostic["code"]) => {
  const error = new ElizaError(
    "The managed owner Calendar connection could not be verified.",
    { code: "MANAGED_CALENDAR_READ_UNAVAILABLE" },
  );
  if (attempt && code)
    Object.defineProperty(error, diagnosticKey, {
      value: Object.freeze({
        version: 1,
        operation: attempt.operation,
        stage: diagnosticStages[code],
        httpStatus: attempt.httpStatus,
        code,
        ...(attempt.broker ? { broker: attempt.broker } : {}),
      }),
    });
  return error;
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const scoped = (v: unknown): v is string =>
  typeof v === "string" && /^alpha-google:[a-f0-9]{64}$/.test(v);

const MANAGED_CALENDAR_BROKER_GRANT_ID = "alpha-google:broker";

function diagnosticCode(value: unknown): value is ReadDiagnostic["code"] {
  return Object.keys(diagnosticStages).some((code) => code === value);
}

/** Snapshot own data descriptors once; optional metadata never invokes getters. */
export function managedCalendarReadDiagnostic(
  error: unknown,
): ReadDiagnostic | undefined {
  try {
    if (!record(error)) return;
    const errorCode = Object.getOwnPropertyDescriptor(error, "code");
    const marker = Object.getOwnPropertyDescriptor(error, diagnosticKey);
    if (
      !errorCode ||
      !("value" in errorCode) ||
      errorCode.value !== "MANAGED_CALENDAR_READ_UNAVAILABLE" ||
      !marker ||
      !("value" in marker) ||
      marker.enumerable !== false
    )
      return;
    const value: unknown = marker.value;
    if (!record(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const required = ["version", "operation", "stage", "httpStatus", "code"];
    if (
      keys.length < 5 ||
      keys.length > 6 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          (!required.includes(key) && key !== "broker"),
      )
    )
      return;
    if (required.some((key) => !Object.hasOwn(descriptors, key))) return;
    for (const key of keys) {
      const descriptor = descriptors[key as string];
      if (
        !descriptor ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      )
        return;
    }
    const version: unknown = descriptors.version?.value;
    const operation: unknown = descriptors.operation?.value;
    const stage: unknown = descriptors.stage?.value;
    const httpStatus: unknown = descriptors.httpStatus?.value;
    const code: unknown = descriptors.code?.value;
    const brokerValue: unknown = descriptors.broker?.value;
    if (
      version !== 1 ||
      (operation !== "sources" && operation !== "feed") ||
      !diagnosticCode(code) ||
      stage !== diagnosticStages[code] ||
      !(
        httpStatus === null ||
        (typeof httpStatus === "number" &&
          Number.isInteger(httpStatus) &&
          httpStatus >= 100 &&
          httpStatus <= 599)
      )
    )
      return;
    let broker: CalendarReadBrokerDiagnostic | undefined;
    if (Object.hasOwn(descriptors, "broker")) {
      // Only the authenticated classified read-409 transport branch can attach it.
      if (code !== "HTTP_STATUS" || stage !== "http" || httpStatus !== 409)
        return;
      const encoded = calendarReadBrokerDiagnosticHeader.encode(brokerValue);
      if (!encoded) return;
      broker = calendarReadBrokerDiagnosticHeader.decode(encoded, operation);
      if (!broker) return;
    }
    return {
      version: 1,
      operation,
      stage: diagnosticStages[code],
      httpStatus,
      code,
      ...(broker ? { broker } : {}),
    };
  } catch {
    // Invalid optional metadata cannot replace the domain failure.
    return undefined;
  }
}

/** Preserve the public source error's identity and JSON; metadata dies with
 * this object or an ordinary clone. No parallel diagnostic store is created.
 */
export function attachManagedCalendarReadDiagnostic(
  target: LifeOpsCalendarSourceError,
  cause: unknown,
): LifeOpsCalendarSourceError {
  const diagnostic =
    cause instanceof ElizaError
      ? managedCalendarReadDiagnostic(cause)
      : undefined;
  if (diagnostic) {
    try {
      Object.defineProperty(target, diagnosticKey, {
        value: Object.freeze(diagnostic),
      });
    } catch {
      /* Optional diagnostics must not change a frozen public error. */
    }
  }
  return target;
}

/** Existing authorized owner HTTP routes are the sole serialization seam.
 * Canonical internal feeds and action/model sourceIssues stay unchanged.
 */
export function ownerCalendarFeedWithReadDiagnostics(feed: unknown): unknown {
  if (!record(feed) || !Array.isArray(feed.sources)) return feed;
  let changed = false;
  const sources = feed.sources.map((source) => {
    if (!record(source) || !record(source.error)) return source;
    const diagnostic = managedCalendarReadDiagnostic(source.error);
    const hasUntrustedField = Object.hasOwn(source.error, "diagnostic");
    if (!diagnostic && !hasUntrustedField) return source;
    // Preserve the existing public data shape without invoking any accessor,
    // including an untrusted diagnostic getter merely to remove that field.
    const publicError: Record<string, unknown> = {};
    try {
      const descriptors = Object.getOwnPropertyDescriptors(source.error);
      for (const key of ["code", "message", "retryable"]) {
        const descriptor = descriptors[key];
        if (descriptor && "value" in descriptor && descriptor.enumerable) {
          Object.defineProperty(publicError, key, descriptor);
        }
      }
    } catch {
      // A hostile optional error object cannot break the owner feed response.
    }
    const error = diagnostic ? { ...publicError, diagnostic } : publicError;
    if (diagnostic)
      Object.defineProperty(error, diagnosticKey, {
        value: Object.freeze(diagnostic),
      });
    changed = true;
    return { ...source, error };
  });
  return changed ? { ...feed, sources } : feed;
}

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
  async function call(
    calendar: object,
    attempt?: ReadAttempt,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const r = await request(url, {
      method: "POST",
      redirect: "error",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ calendar }),
    });
    if (attempt)
      attempt.httpStatus =
        Number.isInteger(r.status) && r.status >= 100 && r.status <= 599
          ? r.status
          : null;
    if (!r.ok || !r.body) {
      if (attempt && !r.ok && r.status === 409) {
        try {
          const broker = calendarReadBrokerDiagnosticHeader.decode(
            r.headers.get(calendarReadBrokerDiagnosticHeader.name),
            attempt.operation,
          );
          if (broker) attempt.broker = broker;
        } catch {
          // Optional header diagnostics cannot replace the original refusal.
        }
      }
      await r.body?.cancel();
      throw fail(attempt, !r.ok ? "HTTP_STATUS" : "BODY_MISSING");
    }
    const reader = r.body.getReader(),
      chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 256 * 1024) throw fail(attempt, "BODY_LIMIT");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(value)) throw fail(attempt, "RESPONSE_NOT_OBJECT");
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
      const attempt: ReadAttempt = { operation: "sources", httpStatus: null };
      const { calendars } = await call({ operation: "sources" }, attempt);
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
        throw fail(attempt, "SOURCES_SCHEMA_INVALID");
      // An unavailable association must not hide an otherwise readable source.
      // Only this verified private host response may supply the reference.
      return calendars.map((calendar) => {
        const { managedGoogleConnectionId: reference, ...summary } = calendar;
        return managedGoogleConnectionId.safeParse(reference).success
          ? { ...summary, managedGoogleConnectionId: reference }
          : summary;
      }) as LifeOpsCalendarSummary[];
    },
    async feed(
      calendar: LifeOpsCalendarSummary,
      timeMin: string,
      timeMax: string,
      timeZone: string,
      agentId: string,
      signal?: AbortSignal,
    ): Promise<LifeOpsCalendarFeed> {
      const attempt: ReadAttempt = { operation: "feed", httpStatus: null };
      if (!scoped(calendar.grantId))
        throw fail(attempt, "REQUEST_SOURCE_INVALID");
      const { feed } = await call(
        {
          operation: "feed",
          grantId: calendar.grantId,
          calendarId: calendar.calendarId,
          timeMin,
          timeMax,
          timeZone,
        },
        attempt,
        signal,
      );
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
        throw fail(attempt, "FEED_SCHEMA_INVALID");
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
        throw fail(attempt, "SOURCE_HEALTH_INVALID");
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
          throw fail(attempt, "EVENT_SCHEMA_INVALID");
      const result = feed as unknown as LifeOpsCalendarFeed;
      return {
        ...result,
        events: result.events.map((event) => ({ ...event, agentId })),
      };
    },
  };
}

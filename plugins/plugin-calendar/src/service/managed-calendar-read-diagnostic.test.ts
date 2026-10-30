/** Prepared owning diagnostics: real transport decoder, CalendarService/store
 * and owner route; all HTTP responses are scripted, with no provider/model call.
 * Not executed or type-qualified by preparing this file.
 */
import { ElizaError, isObjectRecord, type IAgentRuntime } from "@elizaos/core";
import { calendarReadBrokerDiagnosticHeader, type CalendarReadBrokerDiagnostic } from "@elizaos/contracts";
import { createMockRuntime } from "@elizaos/testing";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { __testing } from "../apple-calendar.js";
import { calendarHttpRoutes } from "../routes/plugin-routes.js";
import { CalendarService } from "./CalendarService.js";
import { calendarSchema } from "./schema.js";
import { projectToolResultForModel } from "../../../plugin-assistant/src/runtime/planner-rendering.ts";
import {
  attachManagedCalendarReadDiagnostic,
  createManagedCalendarRead,
  managedCalendarPlaceholder,
  managedCalendarReadDiagnostic,
  ownerCalendarFeedWithReadDiagnostics,
} from "./managed-calendar-read.js";

const ENDPOINT = "http://127.0.0.1:1/__alpha-owner-gmail";
const TEST_AUTH = "a".repeat(64);
const PAYLOAD_MARKER = "fixture-private-payload-not-for-diagnostics";
const WINDOW = { timeMin: "2026-10-31T19:00:00.000Z", timeMax: "2026-11-01T00:00:00.000Z", timeZone: "America/Los_Angeles" };
const BROKER: CalendarReadBrokerDiagnostic = { version: 1, operation: "sources", stage: "accounts", code: "http",
  status: 404, errorClass: "CloudProtocolError", capabilities: { abortAny: true, abortTimeout: true, fetch: true } };
function brokerHeader(operation: "sources" | "feed" = "sources") {
  const encoded = calendarReadBrokerDiagnosticHeader.encode({ ...BROKER, operation });
  if (!encoded) throw new Error("Fixture contract was not encoded");
  return encoded;
}
function brokerResponse(operation: "sources" | "feed" = "sources", status = 409) {
  return new Response(PAYLOAD_MARKER, { status, headers: { [calendarReadBrokerDiagnosticHeader.name]: brokerHeader(operation) } });
}
const INTERNAL_URL = new URL("http://internal.local/api/calendar");
let testRuntime: Awaited<ReturnType<typeof createTestRuntime>>;

beforeAll(async () => {
  __testing.setMacCalendarBridgeForTest(null);
  testRuntime = await createTestRuntime({
    characterName: "Calendar read diagnostic fixture", enableAutonomy: false,
    // Real calendar tables without starting background watcher services.
    plugins: [{ name: "@elizaos/plugin-calendar", description: "Real Calendar tables for isolated diagnostic tests", schema: calendarSchema }],
  });
}, 180_000);
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
afterAll(async () => { await testRuntime?.cleanup(); __testing.resetMacCalendarBridgeForTest(); });

function responseSource(factory: () => Response | Promise<Response>) {
  vi.stubEnv("ELIZA_MANAGED_CALENDAR_READ_BROKER", ENDPOINT);
  vi.stubEnv("ELIZA_API_TOKEN", TEST_AUTH);
  const request = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    expect(String(input)).toBe(ENDPOINT);
    return factory();
  });
  vi.stubGlobal("fetch", request);
  const reader = createManagedCalendarRead({ ELIZA_MANAGED_CALENDAR_READ_BROKER: ENDPOINT, ELIZA_API_TOKEN: TEST_AUTH }, fetch);
  if (!reader) throw new Error("Expected configured private reader");
  return { request, reader };
}

async function rejected(read: () => Promise<unknown>): Promise<ElizaError> {
  try { await read(); } catch (error) {
    if (error instanceof ElizaError) return error;
    throw error;
  }
  throw new Error("Expected a managed read rejection");
}

function readRoute() {
  const route = calendarHttpRoutes.find(r => r.type === "GET" && r.path === "/api/lifeops/calendar/feed");
  if (!route?.routeHandler) throw new Error("Normal owner feed route missing");
  return route.routeHandler;
}

function ownerRouteRuntime(service: CalendarService) {
  const lookup = vi.fn((type: string) => type === "calendar" ? service : null);
  const runtime = createMockRuntime({ agentId: testRuntime.runtime.agentId,
    getService: lookup as IAgentRuntime["getService"] });
  return { runtime, lookup };
}

function sourceError(body: unknown): Record<string, unknown> {
  if (!isObjectRecord(body) || !Array.isArray(body.sources)) throw new Error("Feed sources missing");
  const source = body.sources.find(s => isObjectRecord(s) && isObjectRecord(s.key) && s.key.grantId === "alpha-google:broker");
  if (!isObjectRecord(source) || !isObjectRecord(source.error)) throw new Error("Managed failure missing");
  return source.error;
}

describe("owner-only managed Calendar read diagnostics", () => {
  it.each([
    ["HTTP rejection", () => new Response(PAYLOAD_MARKER, { status: 503 }), "http", 503, "HTTP_STATUS"],
    ["authenticated read refusal", () => brokerResponse(), "http", 409, "HTTP_STATUS"],
    ["missing body", () => new Response(null, { status: 200 }), "body", 200, "BODY_MISSING"],
    ["body limit", () => new Response("x".repeat(256 * 1024 + 1) + PAYLOAD_MARKER), "body", 200, "BODY_LIMIT"],
    ["non-object", () => Response.json([PAYLOAD_MARKER]), "schema", 200, "RESPONSE_NOT_OBJECT"],
    ["invalid sources", () => Response.json({ calendars: [{ invalid: PAYLOAD_MARKER }] }), "schema", 200, "SOURCES_SCHEMA_INVALID"],
  ] as const)("retains %s failure semantics and exposes only closed owner HTTP fields", async (_label, makeResponse, stage, status, code) => {
    const { reader, request } = responseSource(makeResponse);
    const original = await rejected(() => reader.sources());
    expect(original.code).toBe("MANAGED_CALENDAR_READ_UNAVAILABLE");
    expect(original.message).toBe("The managed owner Calendar connection could not be verified.");
    expect(original.context).toBeUndefined();
    expect(original.severity).toBeUndefined();
    expect(JSON.stringify(original)).not.toContain("diagnostic");

    const service = new CalendarService(testRuntime.runtime);
    const feed = await service.getCalendarFeed(INTERNAL_URL, { ...WINDOW, includeHiddenCalendars: true });
    expect(feed.state).toBe("partial");
    expect(feed.sources.some(s => s.key.provider === "eliza" && s.status === "fresh")).toBe(true);
    const internalError = sourceError(feed);
    expect(internalError).toMatchObject({ code: original.code, message: original.message, retryable: false });
    expect(internalError.diagnostic).toBeUndefined();
    const internalJSON = JSON.stringify(feed);
    expect(internalJSON).not.toContain('"diagnostic"');
    expect(internalJSON).not.toContain(PAYLOAD_MARKER);
    // Exercise the actual model wire projector with the entire canonical feed
    // and a full-health superset of the action's smaller sourceIssues summary.
    const modelJSON = JSON.stringify(projectToolResultForModel({ success: false,
      data: { feed, sourceIssues: feed.sources } }));
    expect(modelJSON).not.toContain('"diagnostic"');
    expect(modelJSON).not.toContain(calendarReadBrokerDiagnosticHeader.name);
    expect(modelJSON).not.toContain(PAYLOAD_MARKER);

    const { runtime, lookup } = ownerRouteRuntime(service);
    const context = { signal: new AbortController().signal, body: undefined, params: {}, query: { ...WINDOW, side: "owner" },
      headers: { host: "agent.local" }, method: "GET", path: "/api/lifeops/calendar/feed", runtime,
      inProcess: false, isTrustedLocal: true };
    const response = await readRoute()(context);
    expect(response.status).toBe(200);
    const diagnostic = sourceError(response.body).diagnostic;
    expect(diagnostic).toEqual({ version: 1, operation: "sources", stage, httpStatus: status, code,
      ...(status === 409 ? { broker: BROKER } : {}) });
    if (!isObjectRecord(diagnostic)) throw new Error("Expected closed diagnostic object");
    expect(Object.keys(diagnostic).sort()).toEqual((status === 409
      ? ["broker", "code", "httpStatus", "operation", "stage", "version"]
      : ["code", "httpStatus", "operation", "stage", "version"]));
    const ownerJSON = JSON.stringify(response.body);
    expect(ownerJSON).not.toContain(PAYLOAD_MARKER);
    expect(ownerJSON).not.toContain(TEST_AUTH);
    expect(ownerJSON).not.toContain(ENDPOINT);
    expect(JSON.stringify(feed)).toBe(internalJSON);

    const reads = request.mock.calls.length;
    lookup.mockClear();
    const denied = await readRoute()({ ...context, isTrustedLocal: false });
    expect(denied.status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(reads);
    await service.stop();
  });

  it("keeps a valid empty managed list and fresh local feed complete", async () => {
    const { reader } = responseSource(() => Response.json({ calendars: [] }));
    expect(await reader.sources()).toEqual([]);
    const service = new CalendarService(testRuntime.runtime);
    const feed = await service.getCalendarFeed(INTERNAL_URL, WINDOW);
    expect(feed.state).toBe("complete");
    expect(feed.sources.every(s => s.status === "fresh" && s.error === null)).toBe(true);
    expect(ownerCalendarFeedWithReadDiagnostics(feed)).toBe(feed);
    await service.stop();
  });

  it("ignores a diagnostic header on a successful empty source list", async () => {
    const response = Response.json({ calendars: [] }, { headers: { [calendarReadBrokerDiagnosticHeader.name]: brokerHeader() } });
    const get = vi.spyOn(response.headers, "get");
    const { reader } = responseSource(() => response);
    expect(await reader.sources()).toEqual([]);
    expect(get).not.toHaveBeenCalled();
  });

  it("leaves configuration construction failures outside read-attempt diagnostics", () => {
    const { request } = responseSource(() => Response.json({ calendars: [] }));
    vi.stubEnv("ELIZA_API_TOKEN", "invalid-fixture-shape");
    try { new CalendarService(testRuntime.runtime); throw new Error("Expected construction refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(ElizaError);
      if (!(error instanceof ElizaError)) throw error;
      expect(error.code).toBe("MANAGED_CALENDAR_READ_UNAVAILABLE");
      expect(error.context).toBeUndefined();
      expect(managedCalendarReadDiagnostic(error)).toBeUndefined();
    }
    expect(request).not.toHaveBeenCalled();
    expect(() => createManagedCalendarRead({ ELIZA_MANAGED_CALENDAR_READ_BROKER: "invalid-url", ELIZA_API_TOKEN: TEST_AUTH }, fetch)).toThrow(TypeError);
  });

  it("uses the actual shared codec and rejects noncanonical or unsafe header metadata", () => {
    const header = brokerHeader();
    expect(header.length).toBeLessThanOrEqual(512);
    expect(calendarReadBrokerDiagnosticHeader.decode(header, "sources")).toEqual(BROKER);
    expect(calendarReadBrokerDiagnosticHeader.decode(header, "feed")).toBeUndefined();
    for (const invalid of [" " + header, header.replace('"version":1', '"version":1,"version":1'), "x".repeat(513), "not-json"]) {
      expect(calendarReadBrokerDiagnosticHeader.decode(invalid, "sources")).toBeUndefined();
    }
    let accessed = false;
    const accessor = { ...BROKER };
    Object.defineProperty(accessor, "code", { enumerable: true, get() { accessed = true; return "http"; } });
    const inherited = Object.assign(Object.create({ payload: PAYLOAD_MARKER }), BROKER);
    for (const invalid of [accessor, inherited, { ...BROKER, extra: PAYLOAD_MARKER },
      { ...BROKER, code: "raw-message" }, { ...BROKER, status: 700 }, { ...BROKER, capabilities: { ...BROKER.capabilities, payload: PAYLOAD_MARKER } },
      { ...BROKER, [Symbol("extra")]: PAYLOAD_MARKER }]) {
      expect(calendarReadBrokerDiagnosticHeader.encode(invalid)).toBeUndefined();
    }
    expect(accessed).toBe(false);
  });

  it("reads only a matching 409 read header before cancellation; other operations/statuses ignore it", async () => {
    const order: string[] = [];
    function reply(status: number) {
      const response = new Response(new ReadableStream({ cancel() { order.push("cancel"); } }), {
        status, headers: { [calendarReadBrokerDiagnosticHeader.name]: brokerHeader() },
      });
      const original = response.headers.get.bind(response.headers);
      vi.spyOn(response.headers, "get").mockImplementation(name => { order.push("header"); return original(name); });
      return response;
    }
    const read = responseSource(() => reply(409));
    const error = await rejected(() => read.reader.sources());
    expect(order).toEqual(["header", "cancel"]);
    expect(managedCalendarReadDiagnostic(error)?.broker).toEqual(BROKER);
    for (const status of [401, 403, 503]) {
      order.length = 0;
      const other = responseSource(() => reply(status));
      expect(managedCalendarReadDiagnostic(await rejected(() => other.reader.sources()))?.broker).toBeUndefined();
      expect(order).toEqual(["cancel"]);
    }
    order.length = 0;
    const mutation = responseSource(() => reply(409));
    expect(managedCalendarReadDiagnostic(await rejected(() => mutation.reader.mutation({ operation: "fixture" })))).toBeUndefined();
    expect(order).toEqual(["cancel"]);
    order.length = 0;
    const grant = `alpha-google:${"b".repeat(64)}`;
    await rejected(() => mutation.reader.writeCapabilities(grant, "primary"));
    expect(order).toEqual(["cancel"]);
  });

  it("ignores malformed and wrong-operation headers without changing the public refusal", async () => {
    for (const header of ["not-json", "x".repeat(513), brokerHeader("feed")]) {
      const read = responseSource(() => new Response(null, { status: 409, headers: { [calendarReadBrokerDiagnosticHeader.name]: header } }));
      const error = await rejected(() => read.reader.sources());
      expect(error.code).toBe("MANAGED_CALENDAR_READ_UNAVAILABLE");
      expect(error.context).toBeUndefined();
      expect(managedCalendarReadDiagnostic(error)).toMatchObject({ httpStatus: 409, code: "HTTP_STATUS" });
      expect(managedCalendarReadDiagnostic(error)?.broker).toBeUndefined();
    }
    const feed = responseSource(() => brokerResponse("feed"));
    const grantId = `alpha-google:${"b".repeat(64)}`;
    const calendar = { ...managedCalendarPlaceholder(), grantId, connectorAccountId: grantId, calendarId: "primary" };
    const error = await rejected(() => feed.reader.feed(calendar, WINDOW.timeMin, WINDOW.timeMax, WINDOW.timeZone, "fixture-agent"));
    expect(managedCalendarReadDiagnostic(error)?.broker).toEqual({ ...BROKER, operation: "feed" });
  });

  it("does not copy forged context and drops private metadata across ordinary serialization", async () => {
    const { reader } = responseSource(() => new Response(PAYLOAD_MARKER, { status: 401 }));
    const original = await rejected(() => reader.sources());
    const target = { code: original.code, message: original.message, retryable: false };
    expect(attachManagedCalendarReadDiagnostic(target, original)).toBe(target);
    expect(managedCalendarReadDiagnostic(target)).toMatchObject({ operation: "sources", httpStatus: 401 });
    const cloned: unknown = JSON.parse(JSON.stringify(target));
    expect(managedCalendarReadDiagnostic(cloned)).toBeUndefined();
    const forged = new ElizaError(original.message, { code: original.code,
      context: { managedCalendarRead: { version: 1, operation: "sources", stage: "http", httpStatus: 200, code: "HTTP_STATUS", payload: PAYLOAD_MARKER } } });
    expect(managedCalendarReadDiagnostic(forged)).toBeUndefined();
    const publicForged = { sources: [{ error: { ...target, diagnostic: { payload: PAYLOAD_MARKER } } }] };
    expect(JSON.stringify(ownerCalendarFeedWithReadDiagnostics(publicForged))).not.toContain(PAYLOAD_MARKER);

    const key = Object.getOwnPropertySymbols(original).find(symbol => {
      const value: unknown = Object.getOwnPropertyDescriptor(original, symbol)?.value;
      return isObjectRecord(value) && value.version === 1 && value.operation === "sources";
    });
    if (!key) throw new Error("Current-call diagnostic metadata missing");
    for (const corrupt of [{ code: "UNRECOGNIZED" }, { httpStatus: 700 }, { stage: "schema" }]) {
      const error = new ElizaError(original.message, { code: original.code });
      Object.defineProperty(error, key, { value: { ...managedCalendarReadDiagnostic(original), ...corrupt } });
      expect(managedCalendarReadDiagnostic(error)).toBeUndefined();
    }
  });

  it("never invokes forged metadata or public diagnostic getters", () => {
    const marker = Symbol.for("eliza.calendar.managed-read-diagnostic.v1");
    const clean = { version: 1, operation: "sources", stage: "http", httpStatus: 409, code: "HTTP_STATUS" };
    const secret = "adversarial-private-secret";
    const getter = vi.fn(() => secret);
    for (const key of Object.keys(clean)) {
      let calls = 0;
      const changing = vi.fn(() => ++calls === 1 ? Reflect.get(clean, key) : secret);
      const metadata = { ...clean };
      Object.defineProperty(metadata, key, { enumerable: true, get: changing });
      Object.freeze(metadata);
      const error = { code: "MANAGED_CALENDAR_READ_UNAVAILABLE", message: "Unavailable", retryable: false };
      Object.defineProperty(error, marker, { value: metadata });
      expect(managedCalendarReadDiagnostic(error)).toBeUndefined();
      expect(changing).not.toHaveBeenCalled();
      Object.defineProperty(error, "diagnostic", { enumerable: true, get: getter });
      const json = JSON.stringify(ownerCalendarFeedWithReadDiagnostics({ sources: [{ error }] }));
      expect(json).not.toContain(secret);
      expect(json).not.toContain("diagnostic");
      expect(changing).not.toHaveBeenCalled();
      expect(getter).not.toHaveBeenCalled();
    }
    const getterCode = Object.defineProperty({}, "code", { get: getter });
    Object.defineProperty(getterCode, marker, { value: clean });
    expect(managedCalendarReadDiagnostic(getterCode)).toBeUndefined();
    const getterMarker = { code: "MANAGED_CALENDAR_READ_UNAVAILABLE" };
    Object.defineProperty(getterMarker, marker, { get: getter });
    expect(managedCalendarReadDiagnostic(getterMarker)).toBeUndefined();
    const brokerAccessor = Object.defineProperty({ ...clean }, "broker", { enumerable: true, get: getter });
    const error = { code: "MANAGED_CALENDAR_READ_UNAVAILABLE" };
    Object.defineProperty(error, marker, { value: brokerAccessor });
    expect(managedCalendarReadDiagnostic(error)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
  });

  it("rejects forged metadata shape and broker provenance outside read HTTP 409", () => {
    const marker = Symbol.for("eliza.calendar.managed-read-diagnostic.v1");
    const clean = { version: 1, operation: "sources", stage: "http", httpStatus: 409, code: "HTTP_STATUS" };
    const invalid = [
      { ...clean, extra: PAYLOAD_MARKER },
      { ...clean, [Symbol("extra")]: PAYLOAD_MARKER },
      Object.assign(Object.create({ inherited: true }), clean),
      { ...clean, broker: undefined },
      { ...clean, httpStatus: 503, broker: BROKER },
      { ...clean, httpStatus: 200, code: "FEED_SCHEMA_INVALID", stage: "schema", broker: BROKER },
      { ...clean, broker: { ...BROKER, operation: "feed" } },
    ];
    for (const metadata of invalid) {
      const error = { code: "MANAGED_CALENDAR_READ_UNAVAILABLE", message: "Unavailable", retryable: false };
      Object.defineProperty(error, marker, { value: metadata });
      expect(managedCalendarReadDiagnostic(error)).toBeUndefined();
      expect(JSON.stringify(ownerCalendarFeedWithReadDiagnostics({ sources: [{ error }] }))).not.toContain(PAYLOAD_MARKER);
    }
    const valid = { code: "MANAGED_CALENDAR_READ_UNAVAILABLE" };
    Object.defineProperty(valid, marker, { value: Object.freeze({ ...clean, broker: BROKER }) });
    expect(managedCalendarReadDiagnostic(valid)?.broker).toEqual(BROKER);
  });

  it("does not let optional attachment failure replace a frozen domain error", async () => {
    const { reader } = responseSource(() => new Response(null, { status: 503 }));
    const cause = await rejected(() => reader.sources());
    const target = Object.freeze({ code: cause.code, message: cause.message, retryable: false });
    expect(attachManagedCalendarReadDiagnostic(target, cause)).toBe(target);
    expect(target.code).toBe("MANAGED_CALENDAR_READ_UNAVAILABLE");
  });

  it("keeps concurrent source/feed attempt status separate", async () => {
    const pending: { resolve: (response: Response) => void } = { resolve: () => { throw new Error("Response not initialized"); } };
    const sourceResponse = new Promise<Response>(resolve => { pending.resolve = resolve; });
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body: unknown = JSON.parse(String(init?.body));
      if (!isObjectRecord(body) || !isObjectRecord(body.calendar)) throw new Error("Expected normal request envelope");
      return body.calendar.operation === "sources" ? sourceResponse : Response.json({ feed: {} });
    });
    const concurrent = createManagedCalendarRead({ ELIZA_MANAGED_CALENDAR_READ_BROKER: ENDPOINT, ELIZA_API_TOKEN: TEST_AUTH }, fetch);
    if (!concurrent) throw new Error("Reader missing");
    const grantId = `alpha-google:${"b".repeat(64)}`;
    const calendar = { ...managedCalendarPlaceholder(), grantId, connectorAccountId: grantId, calendarId: "primary" };
    const sourceErrorPromise = rejected(() => concurrent.sources());
    const feedError = await rejected(() => concurrent.feed(calendar, WINDOW.timeMin, WINDOW.timeMax, WINDOW.timeZone, "fixture-agent"));
    pending.resolve(new Response(null, { status: 503 }));
    const discoveryError = await sourceErrorPromise;
    expect(managedCalendarReadDiagnostic(feedError)).toMatchObject({ operation: "feed", httpStatus: 200, code: "FEED_SCHEMA_INVALID" });
    expect(managedCalendarReadDiagnostic(discoveryError)).toMatchObject({ operation: "sources", httpStatus: 503, code: "HTTP_STATUS" });
  });

  it("preserves thrown transport identity and JSON parse error behavior", async () => {
    const failure = new TypeError("scripted transport failure");
    const { reader } = responseSource(async () => { throw failure; });
    await expect(reader.sources()).rejects.toBe(failure);
    expect(managedCalendarReadDiagnostic(failure)).toBeUndefined();
    const invalid = responseSource(() => new Response("not-json"));
    try { await invalid.reader.sources(); throw new Error("Expected JSON rejection"); }
    catch (error) { expect(error).toBeInstanceOf(SyntaxError); expect(managedCalendarReadDiagnostic(error)).toBeUndefined(); }
  });

  it("does not add diagnostics to mutation or write-capability operations", async () => {
    const failed = responseSource(() => new Response(null, { status: 503 }));
    const error = await rejected(() => failed.reader.mutation({ operation: "fixture-mutation" }));
    expect(error.code).toBe("MANAGED_CALENDAR_READ_UNAVAILABLE");
    expect(error.context).toBeUndefined();
    expect(managedCalendarReadDiagnostic(error)).toBeUndefined();
    const grantId = `alpha-google:${"b".repeat(64)}`;
    const capability = { version: 1, grantId, calendarId: "primary", accountId: "fixture-account", read: true, write: true,
      idempotentCreate: true, conditionalWrites: true, providerExactlyOnce: false };
    const valid = responseSource(() => Response.json(capability));
    expect(await valid.reader.writeCapabilities(grantId, "primary")).toEqual(capability);
  });
});

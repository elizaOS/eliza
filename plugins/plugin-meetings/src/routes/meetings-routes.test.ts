/**
 * /api/meetings route handlers over a real MeetingService — start (400/409/422
 * guards), list, fetch-one, and graceful leave. Deterministic: fake runtime plus
 * scripted adapter, no browser.
 */
import type { AccessContext, RouteHandlerContext, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { MeetingService } from "../service.js";
import {
  FakeMeetingBillingSession,
  makeFakeRuntime,
  ScriptedAdapter,
  scriptedDeps,
} from "../test-support.js";
import { meetingsRoutes } from "./meetings-routes.js";

const MEET_URL = "https://meet.google.com/abc-defg-hij";
const USER = "22222222-2222-2222-2222-222222222222" as UUID;

const userAccess: AccessContext = {
  requesterEntityId: USER,
  role: "USER",
};

function route(method: string, path: string) {
  const found = meetingsRoutes.find(
    (r) => r.type === method && r.path === path,
  );
  if (!found?.routeHandler) throw new Error(`route ${method} ${path} missing`);
  expect(found.rawPath).toBe(true);
  return found.routeHandler;
}

/** Real MeetingService (scripted adapter/pipeline) behind a real runtime stub. */
function makeHarness(billingSessions: FakeMeetingBillingSession[] = []) {
  const fake = makeFakeRuntime();
  const adapter = new ScriptedAdapter("google_meet");
  const { deps } = scriptedDeps([adapter], billingSessions);
  const service = new MeetingService(fake.runtime, deps);
  const services = new Map<string, unknown>([["meetings", service]]);
  const baseGetService = fake.runtime.getService.bind(fake.runtime);
  (fake.runtime as { getService: (name: string) => unknown }).getService = (
    name: string,
  ) => services.get(name) ?? baseGetService(name);
  const ctx = (over: Partial<RouteHandlerContext>): RouteHandlerContext => ({
    body: undefined,
    params: {},
    query: {},
    headers: {},
    method: "GET",
    path: "/api/meetings",
    runtime: fake.runtime,
    inProcess: false,
    ...over,
  });
  return { fake, adapter, service, ctx };
}

describe("/api/meetings routes", () => {
  it("POST validates the body", async () => {
    const { ctx } = makeHarness();
    const post = route("POST", "/api/meetings");
    expect((await post(ctx({ body: undefined }))).status).toBe(400);
    expect((await post(ctx({ body: { meetingUrl: "  " } }))).status).toBe(400);
    expect(
      (await post(ctx({ body: { meetingUrl: "https://example.com/x" } })))
        .status,
    ).toBe(400);
    const mismatch = await post(
      ctx({ body: { meetingUrl: MEET_URL, platform: "zoom" } }),
    );
    expect(mismatch.status).toBe(400);
  });

  it("POST creates a session; duplicate join is 409; zoom without adapter is 422", async () => {
    const { ctx } = makeHarness();
    const post = route("POST", "/api/meetings");
    const created = await post(ctx({ body: { meetingUrl: MEET_URL } }));
    expect(created.status).toBe(201);
    const session = (
      created.body as { session: { id: string; status: string } }
    ).session;
    expect(session.status).toBe("requested");

    const dup = await post(ctx({ body: { meetingUrl: MEET_URL } }));
    expect(dup.status).toBe(409);
    expect((dup.body as { code: string }).code).toBe("already_joined");

    const zoom = await post(
      ctx({ body: { meetingUrl: "https://zoom.us/j/1234567890" } }),
    );
    expect(zoom.status).toBe(422);
  });

  it("POST rejects invalid duration caps before launching", async () => {
    const { fake, ctx, adapter } = makeHarness();
    fake.settings.ELIZA_MEETINGS_MAX_DURATION_MS = "1000";
    const post = route("POST", "/api/meetings");

    const overCap = await post(
      ctx({ body: { meetingUrl: MEET_URL, maxDurationMs: 1001 } }),
    );

    expect(overCap.status).toBe(400);
    expect((overCap.body as { code: string }).code).toBe(
      "invalid_duration_cap",
    );
    expect(adapter.session).toBeNull();
  });

  it("POST maps insufficient initial meeting credits to 402 and does not launch", async () => {
    const billing = new FakeMeetingBillingSession();
    billing.initialReserveError = Object.assign(
      new Error("not enough credits to start meeting transcription"),
      { code: "insufficient_credits" },
    );
    const { ctx, adapter } = makeHarness([billing]);
    const post = route("POST", "/api/meetings");

    const result = await post(ctx({ body: { meetingUrl: MEET_URL } }));

    expect(result.status).toBe(402);
    expect((result.body as { code: string }).code).toBe("insufficient_credits");
    expect(adapter.session).toBeNull();
  });

  it("GET lists all and ?active=1 filters; GET/:id and DELETE/:id round-trip", async () => {
    const { ctx, adapter } = makeHarness();
    const post = route("POST", "/api/meetings");
    const list = route("GET", "/api/meetings");
    const get = route("GET", "/api/meetings/:id");
    const del = route("DELETE", "/api/meetings/:id");

    const created = await post(ctx({ body: { meetingUrl: MEET_URL } }));
    const id = (created.body as { session: { id: string } }).session.id;
    await adapter.started;

    const all = await list(ctx({}));
    expect((all.body as { sessions: unknown[] }).sessions).toHaveLength(1);
    const active = await list(ctx({ query: { active: "1" } }));
    expect((active.body as { sessions: unknown[] }).sessions).toHaveLength(1);

    const one = await get(ctx({ params: { id } }));
    expect(one.status).toBe(200);
    expect(
      (await get(ctx({ params: { id: crypto.randomUUID() } }))).status,
    ).toBe(404);

    const deleted = await del(ctx({ params: { id } }));
    expect(deleted.status).toBe(200);
    expect((deleted.body as { stopped: boolean }).stopped).toBe(true);
    adapter.end("requested_stop");
    await new Promise((r) => setTimeout(r, 10));

    const afterStop = await list(ctx({ query: { active: "true" } }));
    expect((afterStop.body as { sessions: unknown[] }).sessions).toHaveLength(
      0,
    );
    expect(
      (await del(ctx({ params: { id: crypto.randomUUID() } }))).status,
    ).toBe(404);
  });

  it("redacts transcriptId from meeting sessions when the requester cannot read the transcript", async () => {
    const { ctx, adapter } = makeHarness();
    const post = route("POST", "/api/meetings");
    const list = route("GET", "/api/meetings");
    const get = route("GET", "/api/meetings/:id");

    const created = await post(ctx({ body: { meetingUrl: MEET_URL } }));
    const session = (
      created.body as { session: { id: string; transcriptId?: string } }
    ).session;
    expect(session.transcriptId).toBeTypeOf("string");
    await adapter.started;

    const filteredList = await list(ctx({ accessContext: userAccess }));
    const filteredSession = (
      filteredList.body as { sessions: Array<{ transcriptId?: string }> }
    ).sessions[0];
    expect(filteredSession.transcriptId).toBeUndefined();

    const filteredGet = await get(
      ctx({ params: { id: session.id }, accessContext: userAccess }),
    );
    expect(
      (filteredGet.body as { session: { transcriptId?: string } }).session
        .transcriptId,
    ).toBeUndefined();
  });

  it("answers 503 when the meetings service is not running", async () => {
    const fake = makeFakeRuntime();
    const ctx: RouteHandlerContext = {
      body: { meetingUrl: MEET_URL },
      params: {},
      query: {},
      headers: {},
      method: "POST",
      path: "/api/meetings",
      runtime: fake.runtime,
      inProcess: false,
    };
    expect((await route("POST", "/api/meetings")(ctx)).status).toBe(503);
  });
});

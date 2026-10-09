/**
 * Actual Hono route, policy parser and canonical room helpers.
 * Only authenticated principal and Durable Object platform boundaries are mocked.
 * Requires capture-store source composition; never substitutes parser/hash helpers.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realAuth from "@elizaos/cloud-shared/auth";
import { personalSharedAgentId } from "@elizaos/cloud-shared/lib/services/shared-runtime/personal-shared-identity";
import { parseOwnerCapturePolicy } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-owner-model-capture-store";
import { sharedRuntimeRoomKey } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-chat";
import { sharedRuntimeConversationRoomId } from "@elizaos/cloud-shared/lib/services/shared-runtime/shared-runtime-storage-identity";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";

const originalAuthExports = { ...realAuth };
let reader = "33333333-3333-4333-8333-333333333333";
let authFailure: 401 | 403 | undefined;
let readerOrganization: string;
let adminFailure: boolean;
let adminCalls = 0;
mock.module("@elizaos/cloud-shared/auth", () => ({
  requireUserOrApiKeyWithOrg: async () => {
    if (authFailure)
      throw new HTTPException(authFailure, {
        message: "Synthetic auth denial",
      });
    return { id: reader, organization_id: readerOrganization };
  },
  requireAdmin: async () => {
    adminCalls += 1;
    if (adminFailure)
      throw new HTTPException(403, { message: "Synthetic admin denial" });
    if (authFailure)
      throw new HTTPException(authFailure, {
        message: "Synthetic auth denial",
      });
    return { user: { id: reader }, role: "super_admin" };
  },
}));
const { default: app }: { default: Hono<AppEnv> } = await import("./route");

const SESSION = "44444444-4444-4444-8444-444444444444";
const CAPTURE = "55555555-5555-4555-8555-555555555555";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ORG = "11111111-1111-4111-8111-111111111111";
const READER = "33333333-3333-4333-8333-333333333333";
const AGENT = personalSharedAgentId({ organizationId: ORG, userId: OWNER });
const ROOM = "owned-room";
const CHANNEL = sharedRuntimeRoomKey(AGENT, ROOM);
const STORAGE_ROOM = sharedRuntimeConversationRoomId(CHANNEL);
const policy = {
  version: 1,
  sessionId: SESSION,
  organizationId: ORG,
  userId: OWNER,
  readerUserId: READER,
  roomId: STORAGE_ROOM,
  issuedAt: 1_000,
  expiresAt: 61_000,
  retainUntil: 3_601_000,
  maxTurns: 16,
  maxCalls: 32,
  maxBytes: 65_536,
};
const calls: Array<{ name: string; url: string; init: RequestInit }> = [];
let upstreamStatus = 200;
let upstreamThrows = false;
let upstreamBody: object = { capture: "synthetic-private-capture" };
function onlyCall() {
  const [call] = calls;
  if (calls.length !== 1 || !call)
    throw new Error("Expected exactly one platform call");
  return call;
}
function env(
  value: string | undefined = JSON.stringify(policy),
): AppEnv["Bindings"] {
  return {
    // Retrieval must use only the admitted DO, never a direct database or bucket.
    get DATABASE_URL(): string {
      throw new Error("OFFLINE_DATABASE_FORBIDDEN");
    },
    get BLOB(): AppEnv["Bindings"]["BLOB"] {
      throw new Error("OFFLINE_BUCKET_FORBIDDEN");
    },
    SHARED_OWNER_MODEL_CAPTURE_POLICY: value,
    SHARED_RUNTIME_CONVERSATIONS: {
      getByName: (name: string) => ({
        fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
          if (typeof url !== "string" || init === undefined)
            throw new Error("Unexpected synthetic DO fetch invocation");
          calls.push({ name, url, init });
          if (upstreamThrows) throw new Error("Synthetic platform failure");
          return Response.json(upstreamBody, {
            status: upstreamStatus,
            headers: {
              "Set-Cookie": "must-not-forward=synthetic",
              "X-Platform-Only": "hidden",
            },
          });
        },
      }),
    },
  };
}
function request(body: unknown, bindings = env()) {
  return app.request(
    "/read",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer synthetic",
        Cookie: "session=synthetic",
      },
      body: JSON.stringify(body),
    },
    bindings,
  );
}
function privateHeaders(response: Response) {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Pragma")).toBe("no-cache");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Vary")).toBe("Authorization, Cookie");
}
const savedFetch = globalThis.fetch;
beforeEach(() => {
  reader = READER;
  readerOrganization = ORG;
  adminFailure = false;
  adminCalls = 0;
  authFailure = undefined;
  calls.length = 0;
  upstreamStatus = 200;
  upstreamThrows = false;
  upstreamBody = { capture: "synthetic-private-capture" };
  const blockedFetch: typeof fetch = Object.assign(
    async () => {
      throw new Error("OFFLINE_NETWORK_FORBIDDEN");
    },
    {
      preconnect: () => {
        throw new Error("OFFLINE_NETWORK_FORBIDDEN");
      },
    },
  );
  globalThis.fetch = blockedFetch;
});
afterAll(() => {
  globalThis.fetch = savedFetch;
  mock.module("@elizaos/cloud-shared/auth", () => originalAuthExports);
  mock.restore();
});

describe("exact-reader private capture Hono retrieval", () => {
  test("authentication and non-reader admin denial never reach the platform", async () => {
    for (const status of [401, 403] as const) {
      authFailure = status;
      const result = await request({
        roomKey: ROOM,
        sessionId: SESSION,
        captureId: CAPTURE,
      });
      expect(result.status).toBe(status);
      privateHeaders(result);
    }
    authFailure = undefined;
    reader = OWNER;
    const denied = await request({
      roomKey: ROOM,
      sessionId: SESSION,
      captureId: CAPTURE,
    });
    expect(denied.status).toBe(403);
    privateHeaders(denied);
    expect(calls).toHaveLength(0);
  });

  test("exact owner reader can retrieve without any administrator role", async () => {
    reader = OWNER;
    adminFailure = true;
    const result = await request(
      { roomKey: ROOM, sessionId: SESSION, captureId: CAPTURE },
      env(JSON.stringify({ ...policy, readerUserId: OWNER })),
    );
    expect(result.status).toBe(200);
    privateHeaders(result);
    expect(adminCalls).toBe(0);
    expect(JSON.parse(String(onlyCall().init.body))).toEqual({
      sessionId: SESSION,
      captureId: CAPTURE,
      readerUserId: OWNER,
      verifiedAdmin: false,
    });
  });

  test("same owner id from wrong organization cannot read or fall back to admin", async () => {
    reader = OWNER;
    readerOrganization = READER;
    const result = await request(
      { roomKey: ROOM, sessionId: SESSION },
      env(JSON.stringify({ ...policy, readerUserId: OWNER })),
    );
    expect(result.status).toBe(403);
    expect(adminCalls).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("distinct exact reader still requires real administrator authorization", async () => {
    adminFailure = true;
    const result = await request({ roomKey: ROOM, sessionId: SESSION });
    expect(result.status).toBe(403);
    expect(adminCalls).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("actual policy parser and two-stage room identity reject invalid or one-stage scope", async () => {
    expect(parseOwnerCapturePolicy(JSON.stringify(policy))?.readerUserId).toBe(
      READER,
    );
    expect(CHANNEL).not.toBe(STORAGE_ROOM);
    for (const value of [
      "",
      JSON.stringify({ ...policy, extra: true }),
      JSON.stringify({ ...policy, maxCalls: 33 }),
      JSON.stringify({ ...policy, roomId: CHANNEL }),
    ]) {
      const result = await request(
        { roomKey: ROOM, sessionId: SESSION, captureId: CAPTURE },
        env(value),
      );
      expect(result.status).toBe(404);
      privateHeaders(result);
    }
    const wrongRoom = await request({
      roomKey: "other-room",
      sessionId: SESSION,
      captureId: CAPTURE,
    });
    expect(wrongRoom.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("payload retrieval uses canonical addressing and forwards only the reader locator", async () => {
    const result = await request({
      roomKey: "  owned-room  ",
      sessionId: SESSION,
      captureId: CAPTURE,
    });
    expect(result.status).toBe(200);
    privateHeaders(result);
    expect(await result.text()).toBe(JSON.stringify(upstreamBody));
    expect(calls).toHaveLength(1);
    expect(onlyCall().name).toBe(`${AGENT}:${ROOM}`);
    expect(onlyCall().url).toBe(
      "https://shared-runtime.internal/owner-capture/read",
    );
    expect(onlyCall().init.method).toBe("POST");
    expect(JSON.parse(String(onlyCall().init.body))).toEqual({
      sessionId: SESSION,
      captureId: CAPTURE,
      readerUserId: READER,
      verifiedAdmin: true,
    });
    const forwarded = new Headers(onlyCall().init.headers);
    expect(forwarded.get("Authorization")).toBeNull();
    expect(forwarded.get("Cookie")).toBeNull();
    expect(onlyCall().init.signal).toBeInstanceOf(AbortSignal);
    expect(result.headers.get("Set-Cookie")).toBeNull();
    expect(result.headers.get("X-Platform-Only")).toBeNull();
  });

  test("status-list omission forwards no capture id or payload selector", async () => {
    upstreamBody = {
      captures: [
        { captureId: CAPTURE, status: "stored", traceId: "a".repeat(32) },
      ],
    };
    const result = await request({ roomKey: ROOM, sessionId: SESSION });
    expect(result.status).toBe(200);
    privateHeaders(result);
    expect(JSON.parse(String(onlyCall().init.body))).toEqual({
      sessionId: SESSION,
      readerUserId: READER,
      verifiedAdmin: true,
    });
    expect(await result.text()).toBe(JSON.stringify(upstreamBody));
  });

  test("closed request grammar rejects caller identity, malformed ids and unsafe rooms", async () => {
    for (const body of [
      { roomKey: ROOM, sessionId: SESSION, captureId: null },
      { roomKey: ROOM, sessionId: "not-a-uuid" },
      { roomKey: ROOM, sessionId: SESSION, readerUserId: READER },
      { roomKey: "x".repeat(513), sessionId: SESSION },
      { roomKey: "owned-room\nother", sessionId: SESSION },
      { roomKey: "", sessionId: SESSION },
    ]) {
      const result = await request(body);
      expect(result.status).toBe(400);
      privateHeaders(result);
    }
    const wrongSession = await request({ roomKey: ROOM, sessionId: CAPTURE });
    expect(wrongSession.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("declared and streaming oversized bodies are rejected before platform forwarding", async () => {
    const text = JSON.stringify({
      roomKey: ROOM,
      sessionId: SESSION,
      padding: "x".repeat(5000),
    });
    const declared = await app.request(
      "/read",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(new TextEncoder().encode(text).byteLength),
        },
        body: text,
      },
      env(),
    );
    expect(declared.status).toBe(413);
    privateHeaders(declared);
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2000));
        controller.enqueue(bytes.slice(2000));
        controller.close();
      },
    });
    const streaming = await app.fetch(
      new Request("https://test.invalid/read", {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit),
      env(),
    );
    expect(streaming.status).toBe(413);
    privateHeaders(streaming);
    expect(calls).toHaveLength(0);
  });

  test("missing or failed platform binding returns a private service failure", async () => {
    const missing = env();
    delete (missing as { SHARED_RUNTIME_CONVERSATIONS?: unknown })
      .SHARED_RUNTIME_CONVERSATIONS;
    const absent = await request(
      { roomKey: ROOM, sessionId: SESSION },
      missing,
    );
    expect(absent.status).toBe(503);
    privateHeaders(absent);
    upstreamThrows = true;
    const failed = await request({ roomKey: ROOM, sessionId: SESSION });
    expect(failed.status).toBe(503);
    privateHeaders(failed);
  });

  test("upstream denial remains opaque without invented expiry or absence semantics", async () => {
    upstreamStatus = 403;
    upstreamBody = { code: "owner_capture_read_forbidden" };
    const result = await request({
      roomKey: ROOM,
      sessionId: SESSION,
      captureId: CAPTURE,
    });
    expect(result.status).toBe(403);
    privateHeaders(result);
    expect(await result.text()).toBe(JSON.stringify(upstreamBody));
  });
});

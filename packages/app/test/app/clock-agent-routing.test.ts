/** Real selector, native HTTP wire, authenticated SQL device store and proposal
 * action. Capacitor is controlled; no model, Android dispatch or phone effect. */

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Memory } from "@elizaos/core";
import {
  DeviceActionService,
  withDeviceActionTurn,
} from "@elizaos/plugin-assistant";
import { createMemoryStorage } from "@elizaos/testing/browser-mocks";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  APPROVAL_SERVICE,
  ApprovalService,
} from "../../../../plugins/plugin-assistant/src/services/approval/service.ts";
import { proposeDeviceAction } from "../../../../plugins/plugin-assistant/src/services/device-actions/action.ts";
import { deviceRequestCredential } from "../../../agent/src/api/device-action-routes.ts";
import { rememberCsrfTokenForUrl } from "../../../ui/src/api/auth/csrf-cookie.ts";
import { ElizaClient } from "../../../ui/src/api/client.ts";
import { requestViaAgentTransport } from "../../../ui/src/api/csrf-client.ts";
import { getClockHost } from "../../../ui/src/bridge/clock-host.ts";
import { createMachineSession } from "../../src/api/auth/sessions.ts";
import { resolveAuthorizedRouteRole } from "../../src/api/auth.ts";
import {
  AuthStore,
  type DrizzleDatabase,
} from "../../src/services/auth-store.ts";
import { createRealTestRuntime } from "../helpers/real-runtime.ts";

const native = vi.hoisted(() => ({
  base: "",
  scope: "a".repeat(64),
  installationId: "clock-fixture",
  status: vi.fn(),
  request: vi.fn(),
  http: vi.fn(),
  cancel: vi.fn(async () => ({ cancelled: true })),
  list: vi.fn(),
  alarms: vi.fn(),
  manage: vi.fn(),
  permission: vi.fn(),
  review: vi.fn(async () => ({
    result: { kind: "clock-handoff", action: "set", status: "opened" },
    receiptPending: false,
  })),
}));
vi.mock("@capacitor/core", async (original) => ({
  ...(await original<typeof import("@capacitor/core")>()),
  Capacitor: {
    isNativePlatform: () => true,
    getPlatform: () => "android",
    isPluginAvailable: () => true,
  },
  CapacitorHttp: { request: native.http },
  registerPlugin: () => ({
    getStatus: native.status,
    getAlarmStatus: native.alarms,
    manageAlarm: native.manage,
    requestAlarmPermission: native.permission,
    requestAgent: native.request,
    cancelAgentRequest: native.cancel,
    listProposals: native.list,
    reviewClock: native.review,
    cancelClock: vi.fn(async () => ({ cancelled: true })),
    addListener: vi.fn(async () => ({ remove: async () => {} })),
  }),
}));
// Unrelated platform adapters are unavailable; tested native HTTP/Clock and the
// shipped host selector/client remain real.
vi.mock("../../src/renderer/transports/android-native-agent-transport", () => ({
  androidNativeAgentTransportForUrl: async () => null,
  androidNativeAgentLifecycleForUrl: async () => null,
}));
vi.mock("../../src/renderer/transports/ios-local-agent-transport", () => ({
  iosInProcessAgentTransportForUrl: async () => null,
  isIosInProcessLocalAgentBase: () => false,
  isTerminalIosNativeAgentBootErrorMessage: () => false,
}));
vi.mock("../../src/renderer/transports/desktop-local-agent-transport", () => ({
  desktopLocalAgentTransportForUrl: async () => null,
}));
vi.mock("../../src/renderer/transports/desktop-http-transport", () => ({
  desktopHttpTransportForUrl: () => null,
}));
vi.mock("../../src/renderer/transports/remote-relay-transport", () => ({
  remoteRelayTransportForUrl: () => null,
}));
vi.mock("../../src/renderer/transports/ssh-runtime-transport", () => ({
  sshRuntimeTransportForUrl: () => null,
}));

import "../../src/renderer/transports/configure.ts";

describe("Clock preserves existing agent device routing", () => {
  let fixture: Awaited<ReturnType<typeof createRealTestRuntime>>;
  let server: Server;
  let client: ElizaClient;
  let service: DeviceActionService;
  let bearer: string;
  let nativeClasses: string;
  let java: string;
  const csrf = "current-native-csrf";
  const cookie = `eliza_fixture_session=current; eliza_csrf=${csrf}`;
  const actor = randomUUID();
  const original = {
    subjectUserId: actor,
    installationId: randomUUID(),
    deviceKey: "a".repeat(64),
    capabilities: [
      "notes.local-record.v1",
      "reminders.local-record.v2",
      "calendar.local-event.v1",
    ],
  };
  const clock = {
    subjectUserId: actor,
    installationId: randomUUID(),
    deviceKey: "b".repeat(64),
    capabilities: ["clock.handoff.v1", "clock.handoff.v2"],
  };
  const revision = "c".repeat(64);
  const selection = {
    kind: "notes",
    id: "selected-note",
    revision: 12,
    sensitive: false,
    sourceRevision: revision,
  };
  const requests: Array<{
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];
  let operation: unknown;
  let operationKey: string;

  beforeAll(async () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    const javaBin = process.env.JAVA_HOME
      ? join(process.env.JAVA_HOME, "bin")
      : existsSync("/opt/homebrew/opt/openjdk@21/bin/java")
        ? "/opt/homebrew/opt/openjdk@21/bin"
        : "";
    java = javaBin ? join(javaBin, "java") : "java";
    nativeClasses = await mkdtemp(join(tmpdir(), "clock-header-policy-"));
    const root = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../..",
    );
    const compiled = spawnSync(
      javaBin ? join(javaBin, "javac") : "javac",
      [
        "--release",
        "17",
        "--add-modules",
        "jdk.httpserver",
        "-d",
        nativeClasses,
        join(
          root,
          "packages/app/platforms/android/app/src/main/java/ai/elizaos/app/ClockHostPolicy.java",
        ),
        join(
          root,
          "packages/app/platforms/android/app/src/main/java/ai/elizaos/app/ClockHostHttp.java",
        ),
        join(root, "packages/app/test/android/ClockHostPolicyTest.java"),
      ],
      { encoding: "utf8" },
    );
    if (compiled.error || compiled.status !== 0)
      throw Error(
        `Native header policy compilation failed: ${compiled.error?.message ?? compiled.stderr}`,
      );
    fixture = await createRealTestRuntime({
      characterName: "ClockRoutingFixture",
      withLLM: false,
    });
    expect(fixture.providerName).toBeNull();
    await fixture.runtime.registerService(ApprovalService);
    await fixture.runtime.getServiceLoadPromise(APPROVAL_SERVICE);
    const auth = new AuthStore(fixture.runtime.adapter.db as DrizzleDatabase);
    await auth.createIdentity({
      id: actor,
      kind: "machine",
      displayName: "Routing fixture",
      createdAt: Date.now(),
      passwordHash: null,
    });
    bearer = (
      await createMachineSession(auth, { identityId: actor, scopes: [] })
    ).session.id;
    service = new DeviceActionService(fixture.runtime);
    await service.register(original, "Existing device", 1);
    await service.register(clock, "Clock device", 1);
    const context = await service.context(clock);
    native.scope = context.scope;
    native.installationId = clock.installationId;
    server = createServer(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      requests.push({
        url: request.url ?? "",
        headers: { ...request.headers },
        body,
      });
      const send = (value: unknown, status = 200) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      };
      try {
        const authorization = await resolveAuthorizedRouteRole(request, {
          store: auth,
          allowTrustedLocalBypass: false,
          allowCookieAuth: false,
          allowBearerAuth: true,
        });
        if (
          authorization.ok &&
          request.url?.startsWith("/api/conversations/id/greeting")
        ) {
          send({
            text: "Hello from the existing transport",
            agentName: "Eliza",
            generated: true,
          });
          return;
        }
        if (
          authorization.ok &&
          request.url === "/api/conversations/id/messages/stream"
        ) {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(
            'data: {"type":"done","fullText":"Cloud reply","agentName":"Eliza"}\n\n',
          );
          return;
        }
        if (
          authorization.ok &&
          ["/api/status", "/api/conversations"].includes(request.url ?? "")
        ) {
          send({ state: "running", conversations: [] });
          return;
        }
        const credential = deviceRequestCredential(request, {
          ...authorization,
          role: authorization.ok ? authorization.role : "NONE",
        });
        if (!credential) {
          send({ error: "Unauthorized fixture request" }, 401);
          return;
        }
        const parsed = JSON.parse(body);
        if (
          parsed.metadata !== undefined &&
          (!parsed.metadata ||
            typeof parsed.metadata !== "object" ||
            Array.isArray(parsed.metadata))
        ) {
          send({ error: "Invalid metadata" }, 400);
          return;
        }
        await withDeviceActionTurn(fixture.runtime, credential, async () => {
          if (!proposeDeviceAction.handler)
            throw Error("Missing registered proposal action");
          const result = await proposeDeviceAction.handler(
            fixture.runtime,
            {
              id: randomUUID(),
              entityId: actor,
              agentId: fixture.runtime.agentId,
              roomId: randomUUID(),
              content: { text: parsed.text, metadata: parsed.metadata },
            } as Memory,
            undefined,
            {
              parameters: {
                operation,
                operationKey,
                reason: "Authenticated routing fixture",
              },
            },
          );
          send({ result, proposals: await service.list(credential) });
        });
      } catch {
        send({ error: "Device or proposal unavailable" }, 409);
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw Error("Missing fixture listener");
    native.base = `http://127.0.0.1:${address.port}`;
    vi.stubGlobal(
      "window",
      Object.assign(new EventTarget(), {
        localStorage,
        location: new URL("https://localhost"),
      }),
    );
    client = new ElizaClient(native.base, bearer);
    localStorage.setItem("eliza:mobile-runtime-mode", "remote-mac");
    rememberCsrfTokenForUrl(native.base, csrf);
    native.http.mockImplementation(
      async (input: {
        url: string;
        method: string;
        headers: Record<string, string>;
        data: unknown;
      }) => {
        const result = await fetch(input.url, {
          method: input.method,
          headers: input.headers,
          body: JSON.stringify(input.data),
        });
        return {
          status: result.status,
          data: await result.text(),
          headers: { "content-type": "application/json" },
        };
      },
    );
    native.request.mockImplementation(
      async (input: {
        path: string;
        method: string;
        body: string;
        headers: Record<string, string>;
      }) => {
        // Feed the actual paired client header bytes into the production native
        // admission function used by ClockHostClient, rather than emulate it.
        const encode = (value: string) => {
          const data = Buffer.from(value, "utf8"),
            size = Buffer.alloc(2);
          size.writeUInt16BE(data.length);
          return Buffer.concat([size, data]);
        };
        const entries = Object.entries(input.headers),
          count = Buffer.alloc(4);
        count.writeInt32BE(entries.length);
        const admitted = spawnSync(
          java,
          [
            "--add-modules",
            "jdk.httpserver",
            "-cp",
            nativeClasses,
            "ai.elizaos.app.ClockHostPolicyTest",
            "headers",
          ],
          {
            input: Buffer.concat([
              encode(bearer),
              encode(cookie),
              count,
              ...entries.flatMap(([name, value]) => [
                encode(name),
                encode(value),
              ]),
            ]),
          },
        );
        if (admitted.error || admitted.status !== 0)
          throw Error(
            "Actual native authentication/header admission rejected the request",
          );
        const publicHeaders: Record<string, string> = {};
        let offset = 4;
        const read = () => {
          const size = admitted.stdout.readUInt16BE(offset);
          offset += 2;
          const value = admitted.stdout
            .subarray(offset, offset + size)
            .toString("utf8");
          offset += size;
          return value;
        };
        for (let i = 0; i < admitted.stdout.readInt32BE(0); i++)
          publicHeaders[read()] = read();
        expect(
          Object.keys(publicHeaders).some((name) =>
            ["authorization", "cookie", "x-eliza-csrf"].includes(
              name.toLowerCase(),
            ),
          ),
        ).toBe(false);
        const parsed = JSON.parse(input.body);
        parsed.metadata = {
          ...parsed.metadata,
          clientDevice: {
            context: { sensitive: false, revision: 1, timeZone: "UTC" },
          },
        };
        const result = await fetch(native.base + input.path, {
          method: input.method,
          headers: {
            ...publicHeaders,
            authorization: `Bearer ${bearer}`,
            cookie,
            "x-eliza-csrf": csrf,
            "x-eliza-device-id": clock.installationId,
            "x-eliza-device-key": clock.deviceKey,
            "x-eliza-device-capabilities": clock.capabilities.join(","),
          },
          body: JSON.stringify(parsed),
        });
        return {
          status: result.status,
          data: await result.text(),
          headers: { "content-type": "application/json" },
        };
      },
    );
    native.list.mockImplementation(async () => ({
      scope: native.scope,
      proposals: (await service.list(clock)).map((p) => ({
        id: p.id,
        digest: "d".repeat(64),
        state: p.state,
        expiresAt: p.expiresAt.toISOString(),
        operation: (p.payload as { operation: unknown }).operation,
      })),
    }));
  }, 180_000);
  beforeEach(() => {
    client.setToken(bearer);
    native.http.mockClear();
    native.request.mockClear();
    native.status.mockReset();
    native.status.mockImplementation(async () => ({
      supported: true,
      agentBase: native.base,
      reason: null,
      capabilities: clock.capabilities,
      scope: native.scope,
      installationId: clock.installationId,
      context: { sensitive: false, revision: 1, timeZone: "UTC" },
    }));
    native.review.mockClear();
    requests.length = 0;
    operationKey = randomUUID();
  });
  afterAll(async () => {
    if (server)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    await fixture?.cleanup();
    if (nativeClasses)
      await rm(nativeClasses, { recursive: true, force: true });
    localStorage.removeItem("eliza:mobile-runtime-mode");
    vi.unstubAllGlobals();
  });

  it.each([
    {
      type: "notes_read_selected",
      context: { ...selection, id: "note" },
      target: {
        sourceId: "notes",
        sourceRevision: revision,
        noteId: "note",
        revision,
      },
    },
    {
      type: "reminder_read_selected",
      context: { ...selection, kind: "reminder", id: "reminder" },
      target: {
        timingVersion: 2,
        sourceId: "reminders",
        sourceRevision: revision,
        reminderId: "reminder",
        occurrenceId: "occurrence",
        revision,
      },
    },
    {
      type: "calendar_read_selected",
      context: { ...selection, kind: "calendar", id: "event" },
      target: {
        sourceId: "calendar",
        sourceRevision: revision,
        eventId: "event",
        revision,
      },
    },
    {
      type: "open_view",
      view: "notes",
      context: { ...selection, kind: "view", id: "notes" },
    },
  ])(
    "preserves original wire identity/capabilities/context for $type",
    async ({ context, ...selected }) => {
      operation = selected;
      const body = JSON.stringify({
        text: "Propose the selected action",
        metadata: {
          clientDevice: { context },
          retained: "owned source",
        },
      });
      const response = await client.fetch<{
        result: { success: boolean };
        proposals: Array<{
          payload: { installationId: string; operation: unknown };
        }>;
      }>("/api/chat", {
        method: "POST",
        body,
        headers: {
          "x-eliza-device-id": original.installationId,
          "x-eliza-device-key": original.deviceKey,
          "x-eliza-device-capabilities": original.capabilities.join(","),
        },
      });
      expect(response.result.success).toBe(true);
      const saved = response.proposals.find(
        (p) => (p.payload.operation as { type: string }).type === selected.type,
      );
      expect(saved?.payload.installationId).toBe(original.installationId);
      expect(saved?.payload.operation).toEqual(selected);
      expect(requests[0].body).toBe(body);
      expect(requests[0].headers["x-eliza-device-id"]).toBe(
        original.installationId,
      );
      expect(requests[0].headers["x-eliza-device-key"]).toBe(
        original.deviceKey,
      );
      expect(requests[0].headers["x-eliza-device-capabilities"]).toBe(
        original.capabilities.join(","),
      );
      expect(native.http).toHaveBeenCalledOnce();
      expect(native.request).not.toHaveBeenCalled();
      expect(native.status).not.toHaveBeenCalled();
    },
  );
  it("preserves bound requests through the existing caller-authenticated CSRF transport entrypoint", async () => {
    operation = { type: "open_view", view: "notes" };
    const body = JSON.stringify({
      text: "Bound direct request",
      metadata: { clientDevice: { context: selection } },
    });
    const response = await requestViaAgentTransport(`${native.base}/api/chat`, {
      method: "POST",
      body,
      headers: {
        authorization: `Bearer ${bearer}`,
        "content-type": "application/json",
        "x-eliza-device-id": original.installationId,
        "x-eliza-device-key": original.deviceKey,
        "x-eliza-device-capabilities": original.capabilities.join(","),
      },
    });
    expect(response.status).toBe(200);
    expect(requests[0].body).toBe(body);
    expect(requests[0].headers["x-eliza-device-id"]).toBe(
      original.installationId,
    );
    expect(native.http).toHaveBeenCalledOnce();
    expect(native.request).not.toHaveBeenCalled();
    expect(native.status).not.toHaveBeenCalled();
  });
  it.each([undefined, "fr"])(
    "keeps the real bodyless greeting on the existing authenticated transport (%s)",
    async (lang) => {
      const reply = await client.requestGreeting("id", lang);
      expect(reply.text).toBe("Hello from the existing transport");
      expect(requests[0].url).toBe(
        `/api/conversations/id/greeting${lang ? `?lang=${lang}` : ""}`,
      );
      expect(requests[0].body).toBe("");
      expect(requests[0].headers.authorization).toBe(`Bearer ${bearer}`);
      expect(native.http).toHaveBeenCalledOnce();
      expect(native.request).not.toHaveBeenCalled();
      expect(native.status).not.toHaveBeenCalled();
    },
  );
  it("keeps the real dedicated Cloud stream and trace header on its existing authenticated transport", async () => {
    const base = "https://fixture.cloud.eliza.app";
    const pairedStatus = await native.status();
    native.status.mockClear();
    native.status.mockResolvedValue({ ...pairedStatus, agentBase: base });
    const originalFetch = globalThis.fetch;
    const wire = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        return originalFetch(
          url.startsWith(base) ? native.base + url.slice(base.length) : input,
          init,
        );
      });
    try {
      const cloud = new ElizaClient(base, bearer);
      const reply = await cloud.sendConversationMessageStream(
        "id",
        "Cloud message",
        () => {},
      );
      expect(reply.text).toBe("Cloud reply");
      expect(requests).toHaveLength(1);
      expect(requests[0].url).toBe("/api/conversations/id/messages/stream");
      expect(requests[0].headers["x-eliza-trace-id"]).toEqual(
        expect.any(String),
      );
      expect(requests[0].headers.authorization).toBe(`Bearer ${bearer}`);
      expect(JSON.parse(requests[0].body).text).toBe("Cloud message");
      expect(native.request).not.toHaveBeenCalled();
      expect(native.status).not.toHaveBeenCalled();
    } finally {
      wire.mockRestore();
      native.status.mockResolvedValue(pairedStatus);
    }
  });
  it("serves an unrelated authenticated request without consulting a rejected Clock worker", async () => {
    await native.status.withImplementation(
      async () => {
        throw Error("Native Clock worker unavailable");
      },
      async () => {
        expect(await client.fetch("/api/status")).toEqual({
          state: "running",
          conversations: [],
        });
        expect(native.status).not.toHaveBeenCalled();
        expect(native.request).not.toHaveBeenCalled();
        expect(native.http).toHaveBeenCalledOnce();
      },
    );
  });
  it("falls back before dispatch when an eligible request cannot read Clock status", async () => {
    await native.status.withImplementation(
      async () => {
        throw Error("Native Clock worker unavailable");
      },
      async () => {
        expect(await client.fetch("/api/conversations")).toEqual({
          state: "running",
          conversations: [],
        });
        expect(native.status).toHaveBeenCalledOnce();
        expect(native.request).not.toHaveBeenCalled();
        expect(native.http).toHaveBeenCalledOnce();
        expect(requests[0].headers.authorization).toBe(`Bearer ${bearer}`);
      },
    );
  });
  it("creates an actual agent Clock proposal for an unbound authenticated turn and retains private review access", async () => {
    operation = {
      type: "clock_handoff",
      action: "set",
      hour: 9,
      minute: 0,
      label: "Routing canary",
      timeZone: "UTC",
      days: [2, 3, 4, 5, 6],
    };
    const response = await client.fetch<{
      result: { success: boolean };
      proposals: Array<{
        id: string;
        payload: { installationId: string; operation: unknown };
      }>;
    }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        text: "Propose a weekday Clock alarm",
        metadata: { retained: "owned source" },
      }),
    });
    expect(response.result.success).toBe(true);
    const saved = response.proposals.find(
      (p) => (p.payload.operation as { type: string }).type === "clock_handoff",
    );
    expect(saved?.payload.installationId).toBe(clock.installationId);
    expect(saved?.payload.operation).toEqual(operation);
    if (!saved) throw Error("Missing actual Clock proposal");
    const pendingClockId = saved.id;
    expect(native.request).toHaveBeenCalledOnce();
    expect(native.http).not.toHaveBeenCalled();
    expect(JSON.parse(requests[0].body).metadata.retained).toBe("owned source");
    expect(native.request.mock.calls[0][0].headers.authorization).toBe(
      `Bearer ${bearer}`,
    );
    expect(native.request.mock.calls[0][0].headers["x-eliza-csrf"]).toBe(csrf);
    const host = getClockHost();
    if (!host) throw Error("Missing private Clock host");
    const list = await host.proposals();
    expect(list.proposals.some((p) => p.id === pendingClockId)).toBe(true);
    const pending = list.proposals.find((p) => p.id === pendingClockId);
    if (!pending) throw Error("Missing owned Clock review");
    expect(
      (await host.review(pending, native.scope, new AbortController().signal))
        .handoff.status,
    ).toBe("opened");
    expect(native.review).toHaveBeenCalledOnce(); // Controlled consent only; no native effect.
  });
  it.each([
    null,
    [],
    "wrong",
    { clientDevice: null },
    { clientDevice: [] },
    { clientDevice: { context: selection } },
  ])(
    "keeps malformed or existing metadata on its original path: %j",
    async (metadata) => {
      operation = { type: "open_view", view: "notes" };
      const body = JSON.stringify({ text: "Keep original metadata", metadata });
      await expect(
        client.fetch("/api/chat", { method: "POST", body }),
      ).rejects.toBeDefined();
      expect(requests[0].body).toBe(body);
      expect(native.http).toHaveBeenCalledOnce();
      expect(native.request).not.toHaveBeenCalled();
      expect(native.status).not.toHaveBeenCalled();
    },
  );
  it("never falls back to generic HTTP after unbound native authentication fails", async () => {
    native.request.mockResolvedValueOnce({
      status: 401,
      data: JSON.stringify({ error: "Native authentication rejected" }),
      headers: { "content-type": "application/json" },
    });
    await expect(
      client.fetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ text: "Unbound request" }),
      }),
    ).rejects.toBeDefined();
    expect(native.request).toHaveBeenCalledOnce();
    expect(native.http).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
  it.each([
    { Authorization: "Bearer stale-caller" },
    { Cookie: "eliza_fixture_session=foreign" },
    { "x-eliza-csrf": "stale-caller-csrf" },
  ])(
    "rejects foreign paired caller credentials through the production native guard: %j",
    async (headers) => {
      await expect(
        client.fetch("/api/chat", {
          method: "POST",
          body: JSON.stringify({ text: "Foreign caller" }),
          headers,
        }),
      ).rejects.toBeDefined();
      expect(native.request).toHaveBeenCalledOnce();
      expect(native.http).not.toHaveBeenCalled();
      expect(requests).toHaveLength(0);
    },
  );
  it("does not borrow Clock enrollment after original device revocation", async () => {
    await service.revoke(original);
    operation = { type: "open_view", view: "notes" };
    await expect(
      client.fetch("/api/chat", {
        method: "POST",
        body: JSON.stringify({ text: "Revoked action" }),
        headers: {
          "x-eliza-device-id": original.installationId,
          "x-eliza-device-key": original.deviceKey,
          "x-eliza-device-capabilities": original.capabilities.join(","),
        },
      }),
    ).rejects.toBeDefined();
    expect(native.http).toHaveBeenCalledOnce();
    expect(native.request).not.toHaveBeenCalled();
    expect(native.status).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
  });
  it("does not ignore cancellation before transport dispatch", async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      client.fetch("/api/chat", {
        method: "POST",
        body: "{}",
        signal: abort.signal,
      }),
    ).rejects.toBeDefined();
    expect(requests).toHaveLength(0);
    expect(native.request).not.toHaveBeenCalled();
    expect(native.http).not.toHaveBeenCalled();
  });
  it("cancels an admitted unbound native request without replay or generic fallback", async () => {
    let rejectNative: ((error: unknown) => void) | undefined;
    native.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectNative = reject;
        }),
    );
    native.cancel.mockImplementationOnce(async () => {
      rejectNative?.(
        new DOMException("Native request cancelled", "AbortError"),
      );
      return { cancelled: true };
    });
    const abort = new AbortController();
    const request = client.fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ text: "Unbound cancellation" }),
      signal: abort.signal,
    });
    const rejected = expect(request).rejects.toBeDefined();
    await vi.waitFor(() => expect(native.request).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    expect(native.http).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
  it("reads owned alarms independently and rejects false empty or malformed snapshots", async () => {
    const status = {
      available: true,
      reason: null,
      owner: "e".repeat(64),
      alarmsRevision: 4,
      alarmsObservedAt: Date.now(),
      timeZone: "UTC",
      alarms: [],
      exactAlarmsAllowed: true,
      notificationsAllowed: true,
      fullScreenAllowed: false,
      alarmSoundMuted: false,
      defaultToneAvailable: true,
    };
    native.status.mockRejectedValueOnce(new Error("Agent offline"));
    native.alarms.mockResolvedValue(status);
    const host = getClockHost();
    expect(await host?.alarmStatus?.()).toEqual(status);
    native.alarms.mockResolvedValueOnce({
      ...status,
      available: false,
      reason: "Owner unavailable",
      owner: null,
      alarmsRevision: null,
    });
    await expect(host?.alarmStatus?.()).rejects.toThrow(
      "Invalid unavailable native alarm inventory",
    );
    native.alarms.mockResolvedValueOnce({ ...status, alarmsRevision: -1 });
    await expect(host?.alarmStatus?.()).rejects.toThrow("Invalid Clock number");
  });
  it("binds local alarm review to the explicit owner and revision and validates its actual receipt", async () => {
    const owner = "e".repeat(64);
    const status = {
      available: true,
      reason: null,
      owner,
      alarmsRevision: 4,
      alarmsObservedAt: Date.now(),
      timeZone: "UTC",
      alarms: [],
      exactAlarmsAllowed: true,
      notificationsAllowed: true,
      fullScreenAllowed: true,
      alarmSoundMuted: false,
      defaultToneAvailable: true,
    };
    native.alarms.mockResolvedValue(status);
    native.manage.mockReset();
    const host = getClockHost();
    await host?.alarmStatus?.();
    const operation = {
      type: "clock_alarm" as const,
      action: "set" as const,
      hour: 9,
      minute: 0,
      label: "Morning",
      timeZone: "UTC",
      days: [2, 3, 4, 5, 6] as (1 | 2 | 3 | 4 | 5 | 6 | 7)[],
    };
    const result = {
      kind: "clock-alarm",
      action: "set",
      status: "scheduled",
      alarmId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      nextAt: Date.now() + 3_600_000,
    };
    native.manage.mockResolvedValue({ result, alarmsRevision: 5 });
    expect(await host?.manageAlarm?.(operation, 4, owner)).toEqual({
      result,
      alarmsRevision: 5,
    });
    expect(native.manage).toHaveBeenCalledWith({
      operation,
      alarmsRevision: 4,
      expectedOwner: owner,
    });
    native.manage.mockClear();
    native.alarms.mockResolvedValue({ ...status, owner: "f".repeat(64) });
    await host?.alarmStatus?.();
    await expect(host?.manageAlarm?.(operation, 4, owner)).rejects.toThrow(
      "Refresh the alarm list",
    );
    expect(native.manage).not.toHaveBeenCalled();
    native.alarms.mockResolvedValue(status);
    await host?.alarmStatus?.();
    await expect(host?.manageAlarm?.(operation, 3, owner)).rejects.toThrow(
      "Alarm list changed",
    );
    expect(native.manage).not.toHaveBeenCalled();
  });
});

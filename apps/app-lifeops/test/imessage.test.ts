import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock @elizaos/agent/config/config so the mixin's resolveLifeOpsIMessageBridgeConfig
// doesn't depend on real config loading.
vi.mock("@elizaos/agent/config/config", () => ({
  loadElizaConfig: () => ({}),
}));

// child_process must be mocked before importing the bridge.
vi.mock("node:child_process", async (importOriginal) => {
  const actual =
    (await importOriginal()) as typeof import("node:child_process");
  const { EventEmitter } = await import("node:events");
  const util = await import("node:util");

  type ExecCb = (
    err: NodeJS.ErrnoException | null,
    stdout: string,
    stderr: string,
  ) => void;

  const execFile = vi.fn(
    (file: string, args: string[], _opts: unknown, maybeCb?: ExecCb) => {
      const cb =
        typeof _opts === "function" ? (_opts as ExecCb) : maybeCb;
      const handler = execFileBehavior(file, args);
      if (handler.error) {
        cb?.(handler.error, "", handler.stderr ?? "");
      } else {
        cb?.(null, handler.stdout ?? "", handler.stderr ?? "");
      }
      const ee = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      ee.stdout = new EventEmitter();
      ee.stderr = new EventEmitter();
      return ee;
    },
  );

  // promisify(execFile) — install custom hook so async callers see {stdout,stderr}.
  (execFile as unknown as Record<symbol, unknown>)[util.promisify.custom] = (
    file: string,
    args: string[],
  ) =>
    new Promise((resolve, reject) => {
      const handler = execFileBehavior(file, args);
      if (handler.error) {
        reject(handler.error);
      } else {
        resolve({ stdout: handler.stdout ?? "", stderr: handler.stderr ?? "" });
      }
    });

  return { ...actual, execFile, spawn: vi.fn() };
});

type ExecFileBehavior = {
  error?: NodeJS.ErrnoException;
  stdout?: string;
  stderr?: string;
};
const execFileBehaviors: Array<{
  match: (file: string, args: string[]) => boolean;
  result: ExecFileBehavior;
}> = [];

function execFileBehavior(file: string, args: string[]): ExecFileBehavior {
  for (const b of execFileBehaviors) {
    if (b.match(file, args)) return b.result;
  }
  const err: NodeJS.ErrnoException = Object.assign(
    new Error(`command not found: ${file}`),
    { code: "ENOENT" },
  );
  return { error: err };
}

function setExecFile(
  match: (file: string, args: string[]) => boolean,
  result: ExecFileBehavior,
): void {
  execFileBehaviors.push({ match, result });
}

import {
  clearIMessageBackendCache,
  detectIMessageBackend,
  getIMessageDeliveryStatus,
  IMessageBridgeError,
  searchIMessages,
  sendIMessage,
} from "../src/lifeops/imessage-bridge.js";
import { withIMessage } from "../src/lifeops/service-mixin-imessage.js";

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  execFileBehaviors.length = 0;
  clearIMessageBackendCache();
  vi.clearAllMocks();
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  vi.restoreAllMocks();
});

describe("detectIMessageBackend", () => {
  test('returns "none" when neither imsg nor BlueBubbles is available', async () => {
    const backend = await detectIMessageBackend();
    expect(backend).toBe("none");
  });

  test('detects "imsg" when `imsg --version` succeeds', async () => {
    setExecFile(
      (file, args) => file === "imsg" && args[0] === "--version",
      { stdout: "imsg 1.0.0\n" },
    );
    const backend = await detectIMessageBackend();
    expect(backend).toBe("imsg");
  });

  test('detects "bluebubbles" when server info ping succeeds', async () => {
    // imsg is not on PATH (default ENOENT). BlueBubbles ping returns 200.
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ data: { private_api: true } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;

    const backend = await detectIMessageBackend({
      bluebubblesUrl: "http://127.0.0.1:1234",
      bluebubblesPassword: "secret",
    });
    expect(backend).toBe("bluebubbles");
  });
});

describe("sendIMessage", () => {
  test("imsg backend invokes execFile with argv array (no shell interpolation)", async () => {
    setExecFile(
      (file, args) => file === "imsg" && args[0] === "--version",
      { stdout: "1.0.0\n" },
    );
    let capturedArgs: string[] | null = null;
    setExecFile(
      (file, args) => {
        if (file === "imsg" && args[0] === "send") {
          capturedArgs = args;
          return true;
        }
        return false;
      },
      { stdout: "" },
    );

    const result = await sendIMessage({
      to: "+15551112222; rm -rf /",
      text: "hello $(whoami)",
    });
    expect(result.ok).toBe(true);
    expect(capturedArgs).not.toBeNull();
    const sendArgs = capturedArgs!;
    // argv[1] is the destination, argv[2] is the literal text — both passed
    // as discrete argv entries, never concatenated into a shell string.
    expect(sendArgs[0]).toBe("send");
    expect(sendArgs[1]).toBe("+15551112222; rm -rf /");
    expect(sendArgs[2]).toBe("hello $(whoami)");
    expect(sendArgs).toContain("--json");
  });

  test("bluebubbles backend POSTs JSON to /api/v1/message/text", async () => {
    // imsg unavailable → BlueBubbles auto-selected.
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/server/info")) {
        return new Response(
          JSON.stringify({
            data: { private_api: true, helper_connected: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/chat/query")) {
        // resolveBlueBubblesTarget calls listChatsViaBlueBubbles when target
        // doesn't have an iMessage;/SMS;/any; prefix. We pre-prefix the target
        // to avoid that path; return empty array as a safe default.
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/v1/message/text")) {
        // capture the body for assertions
        sentBody = init?.body ? String(init.body) : "";
        return new Response(
          JSON.stringify({ data: { guid: "msg-guid-123" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 500 });
    });
    let sentBody = "";
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await sendIMessage(
      { to: "iMessage;-;+15551112222", text: "hi from bb" },
      {
        preferredBackend: "bluebubbles",
        bluebubblesUrl: "http://127.0.0.1:1234",
        bluebubblesPassword: "pw",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("msg-guid-123");
    expect(sentBody).toContain('"message":"hi from bb"');
    expect(sentBody).toContain('"chatGuid":"iMessage;-;+15551112222"');
    // Verify the message text endpoint was hit at all
    const urls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : (c[0] as URL).toString(),
    );
    expect(urls.some((u) => u.includes("/api/v1/message/text"))).toBe(true);
  });

  test("bluebubbles backend rejects malformed JSON responses with bridge context", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/server/info")) {
        return new Response(
          JSON.stringify({
            data: { private_api: true, helper_connected: true },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/message/text")) {
        return new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    await expect(
      sendIMessage(
        { to: "iMessage;-;+15551112222", text: "hi from bb" },
        {
          preferredBackend: "bluebubbles",
          bluebubblesUrl: "http://127.0.0.1:1234",
          bluebubblesPassword: "pw",
        },
      ),
    ).rejects.toMatchObject({
      backend: "bluebubbles",
      message: "BlueBubbles /api/v1/message/text returned non-JSON body",
    });
  });
});

describe("withIMessage mixin", () => {
  class StubBase {
    runtime = {
      agentId: "test",
      logger: console,
      getService: vi.fn(() => null),
    };
    ownerEntityId = null;
  }
  const Composed = withIMessage(StubBase as never);

  function createService(nativeService: unknown = null) {
    // biome-ignore lint/suspicious/noExplicitAny: mixin stub
    const svc = new (Composed as any)();
    svc.runtime.getService.mockReturnValue(nativeService);
    return svc;
  }

  test("getIMessageConnectorStatus returns the right shape with no backend", async () => {
    const svc = createService();
    const status = await svc.getIMessageConnectorStatus();
    expect(status.available).toBe(false);
    expect(status.connected).toBe(false);
    expect(status.bridgeType).toBe("none");
    expect(status.error).toBe("no_backend_available");
    expect(typeof status.lastCheckedAt).toBe("string");
    expect(Array.isArray(status.diagnostics)).toBe(true);
  });

  test("prefers the native Messages service when it is registered", async () => {
    const nativeService = {
      isConnected: vi.fn(() => true),
      getStatus: vi.fn(() => ({
        available: true,
        connected: true,
        chatDbAvailable: true,
        sendOnly: false,
        chatDbPath: "/Users/test/Library/Messages/chat.db",
        reason: null,
        permissionAction: null,
      })),
      sendMessage: vi.fn(async () => ({
        success: true,
        messageId: "native-message-1",
      })),
      getMessages: vi.fn(async () => [
        {
          id: "row-1",
          text: "hello native",
          handle: "+15551112222",
          chatId: "chat-1",
          timestamp: Date.parse("2026-04-17T18:00:00.000Z"),
          isFromMe: false,
          hasAttachments: false,
        },
      ]),
      getChats: vi.fn(async () => [
        {
          chatId: "chat-1",
          chatType: "direct",
          participants: [{ handle: "+15551112222", isPhoneNumber: true }],
        },
      ]),
    };
    const svc = createService(nativeService);

    await expect(svc.getIMessageConnectorStatus()).resolves.toMatchObject({
      available: true,
      connected: true,
      bridgeType: "native",
      sendMode: "apple-script",
    });
    await expect(svc.readIMessages({ limit: 1 })).resolves.toEqual([
      expect.objectContaining({
        id: "row-1",
        fromHandle: "+15551112222",
        text: "hello native",
        chatId: "chat-1",
      }),
    ]);
    await expect(svc.listIMessageChats()).resolves.toEqual([
      {
        id: "chat-1",
        name: "+15551112222",
        participants: ["+15551112222"],
      },
    ]);
    await expect(
      svc.sendIMessage({ to: "+15551112222", text: "hi" }),
    ).resolves.toEqual({ ok: true, messageId: "native-message-1" });
    await expect(
      svc.searchIMessages({ query: "hello", limit: 1 }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "row-1",
        text: "hello native",
      }),
    ]);
    await expect(
      svc.getIMessageDeliveryStatus(["native-message-1"]),
    ).resolves.toEqual([
      expect.objectContaining({
        messageId: "native-message-1",
        status: "unknown",
        isRead: null,
        isDelivered: null,
      }),
    ]);
    expect(nativeService.sendMessage).toHaveBeenCalledWith(
      "+15551112222",
      "hi",
      {},
    );
  });

  test("uses the configured bridge for reads when native Messages is send-only", async () => {
    const previousUrl = process.env.ELIZA_BLUEBUBBLES_URL;
    const previousPassword = process.env.ELIZA_BLUEBUBBLES_PASSWORD;
    process.env.ELIZA_BLUEBUBBLES_URL = "http://127.0.0.1:5678";
    process.env.ELIZA_BLUEBUBBLES_PASSWORD = "pw";

    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/server/info")) {
        return new Response(
          JSON.stringify({ data: { private_api: true, helper_connected: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/message/query")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                guid: "bb-msg-1",
                text: "read through bridge",
                isFromMe: false,
                dateCreated: Date.parse("2026-04-17T18:30:00.000Z"),
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      const nativeService = {
        isConnected: vi.fn(() => true),
        getStatus: vi.fn(() => ({
          available: true,
          connected: true,
          chatDbAvailable: false,
          sendOnly: true,
          chatDbPath: "/Users/test/Library/Messages/chat.db",
          reason: "Full Disk Access is required to read chat.db.",
          permissionAction: null,
        })),
        sendMessage: vi.fn(async () => ({ success: true })),
        getMessages: vi.fn(async () => []),
      };
      const svc = createService(nativeService);

      await expect(svc.getIMessageConnectorStatus()).resolves.toMatchObject({
        available: true,
        connected: true,
        bridgeType: "bluebubbles",
        sendMode: "private-api",
      });
      await expect(svc.readIMessages({ limit: 1 })).resolves.toEqual([
        expect.objectContaining({
          id: "bb-msg-1",
          text: "read through bridge",
        }),
      ]);
      expect(nativeService.getMessages).not.toHaveBeenCalled();
    } finally {
      if (previousUrl === undefined) {
        delete process.env.ELIZA_BLUEBUBBLES_URL;
      } else {
        process.env.ELIZA_BLUEBUBBLES_URL = previousUrl;
      }
      if (previousPassword === undefined) {
        delete process.env.ELIZA_BLUEBUBBLES_PASSWORD;
      } else {
        process.env.ELIZA_BLUEBUBBLES_PASSWORD = previousPassword;
      }
    }
  });

  test("sendIMessage surfaces the bridge error when no backend exists", async () => {
    const svc = createService();
    await expect(
      svc.sendIMessage({ to: "+15551112222", text: "hi" }),
    ).rejects.toBeInstanceOf(IMessageBridgeError);
  });
});

// ---------------------------------------------------------------------------
// ws2-parity: iMessage search + delivery status
// ---------------------------------------------------------------------------

describe("searchIMessages — imsg backend", () => {
  test("passes query and optional chat as discrete argv entries (no shell)", async () => {
    setExecFile(
      (file, args) => file === "imsg" && args[0] === "--version",
      { stdout: "imsg 2.0.0\n" },
    );

    let capturedArgs: string[] | null = null;
    setExecFile(
      (file, args) => {
        if (file === "imsg" && args[0] === "search") {
          capturedArgs = args;
          return true;
        }
        return false;
      },
      {
        stdout: JSON.stringify([
          {
            id: "msg-111",
            fromHandle: "+15550001111",
            text: "needle in a haystack",
            isFromMe: false,
            sentAt: "2026-04-17T08:00:00.000Z",
          },
        ]),
      },
    );

    const results = await searchIMessages({ query: "needle" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("msg-111");
    expect(results[0].text).toBe("needle in a haystack");

    // Verify argv structure: query and limit are separate entries, never shell-interpolated.
    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs![0]).toBe("search");
    expect(capturedArgs!).toContain("--query");
    expect(capturedArgs![capturedArgs!.indexOf("--query") + 1]).toBe("needle");
    expect(capturedArgs!).toContain("--json");
  });

  test("passes --chat flag when chatId scope is given", async () => {
    setExecFile(
      (file, args) => file === "imsg" && args[0] === "--version",
      { stdout: "imsg 2.0.0\n" },
    );

    let capturedArgs: string[] | null = null;
    setExecFile(
      (file, args) => {
        if (file === "imsg" && args[0] === "search") {
          capturedArgs = args;
          return true;
        }
        return false;
      },
      { stdout: JSON.stringify([]) },
    );

    await searchIMessages({ query: "hi", chatId: "iMessage;+;alice@example.com" });

    expect(capturedArgs).not.toBeNull();
    expect(capturedArgs!).toContain("--chat");
    expect(capturedArgs![capturedArgs!.indexOf("--chat") + 1]).toBe(
      "iMessage;+;alice@example.com",
    );
  });
});

describe("searchIMessages — BlueBubbles backend", () => {
  test("POSTs to /api/v1/message/query with search field", async () => {
    let searchBody: Record<string, unknown> | null = null;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/server/info")) {
        return new Response(
          JSON.stringify({ data: { private_api: true, helper_connected: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/message/query")) {
        searchBody = JSON.parse(init?.body as string ?? "{}");
        return new Response(
          JSON.stringify({
            data: [
              {
                guid: "bb-msg-999",
                text: "bluebubbles result",
                isFromMe: true,
                dateCreated: 1713340800000,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const results = await searchIMessages(
      { query: "bluebubbles result", limit: 5 },
      {
        preferredBackend: "bluebubbles",
        bluebubblesUrl: "http://127.0.0.1:5678",
        bluebubblesPassword: "pw",
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("bb-msg-999");
    expect(results[0].text).toBe("bluebubbles result");

    // Confirm the search field was passed and no regex was applied.
    expect(searchBody).not.toBeNull();
    expect(searchBody!.search).toBe("bluebubbles result");
    expect(searchBody!.limit).toBe(5);
  });
});

describe("getIMessageDeliveryStatus", () => {
  test("imsg backend returns unknown for all IDs (no CLI delivery command)", async () => {
    setExecFile(
      (file, args) => file === "imsg" && args[0] === "--version",
      { stdout: "imsg 2.0.0\n" },
    );

    const results = await getIMessageDeliveryStatus(["id-1", "id-2"]);

    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.status).toBe("unknown");
      expect(result.isRead).toBeNull();
      expect(result.isDelivered).toBeNull();
    }
  });

  test("BlueBubbles backend fetches per-message delivery metadata", async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/v1/server/info")) {
        return new Response(
          JSON.stringify({ data: { private_api: true, helper_connected: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/message/read-msg")) {
        return new Response(
          JSON.stringify({ data: { guid: "read-msg", isRead: true, isDelivered: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/api/v1/message/sent-msg")) {
        return new Response(
          JSON.stringify({ data: { guid: "sent-msg", isRead: false, isDelivered: true } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not mocked", { status: 500 });
    }) as unknown as typeof fetch;

    const results = await getIMessageDeliveryStatus(
      ["read-msg", "sent-msg"],
      {
        preferredBackend: "bluebubbles",
        bluebubblesUrl: "http://127.0.0.1:5678",
        bluebubblesPassword: "pw",
      },
    );

    expect(results).toHaveLength(2);
    const readResult = results.find((r) => r.messageId === "read-msg");
    expect(readResult?.status).toBe("delivered_read");
    expect(readResult?.isRead).toBe(true);

    const sentResult = results.find((r) => r.messageId === "sent-msg");
    expect(sentResult?.status).toBe("delivered");
    expect(sentResult?.isDelivered).toBe(true);
  });

  test("returns empty array for empty message ID list", async () => {
    const results = await getIMessageDeliveryStatus([]);
    expect(results).toEqual([]);
  });
});

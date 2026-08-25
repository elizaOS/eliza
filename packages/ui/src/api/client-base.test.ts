/** Verifies client-base's exported helpers and send-queue policy through the package's configured test harness. */
// @vitest-environment jsdom
// @vitest-environment-options {"url":"https://localhost/"}

/**
 * Unit coverage for the base client surface not owned by the topic suites:
 * id minting, the module-level network-status API, the StreamGenerationError
 * contract, assistant-text normalization, and the offline WS send queue.
 * Real module logic; only the browser WebSocket builtin is stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_STATUS_CHANGE_EVENT } from "../events";
import {
  __getLastKnownNetworkConnected,
  __resetNetworkStatusForTests,
  ElizaClient,
  generateChatClientMessageId,
  isNetworkCurrentlyConnected,
  isStreamGenerationError,
  onNetworkStatusChange,
  StreamGenerationError,
} from "./client-base";

const GENERIC_NO_RESPONSE_TEXT =
  "Sorry, I couldn't generate a response right now. Please try again.";

interface FakeWs {
  url: string;
  readyState: number;
  sent: string[];
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

function stubWebSocketWithInstances(): FakeWs[] {
  const instances: FakeWs[] = [];
  class WebSocketStub {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    readyState = WebSocketStub.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    constructor(readonly url: string) {
      instances.push(this);
    }
    send(payload: string): void {
      this.sent.push(payload);
    }
    close(): void {}
  }
  vi.stubGlobal("WebSocket", WebSocketStub);
  return instances;
}

function openSocket(instances: FakeWs[]): void {
  instances[0].readyState = 1; // OPEN
  instances[0].onopen?.();
}

function sentFrames(socket: FakeWs): Record<string, unknown>[] {
  return socket.sent.map(
    (payload) => JSON.parse(payload) as Record<string, unknown>,
  );
}

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function dispatchNetworkStatus(connected: unknown): void {
  document.dispatchEvent(
    new CustomEvent(NETWORK_STATUS_CHANGE_EVENT, {
      detail: { connected },
    }),
  );
}

describe("ElizaClient message id minting", () => {
  it("mints distinct non-empty ids across repeated calls", () => {
    const ids = Array.from({ length: 200 }, () =>
      ElizaClient.generateMessageId(),
    );
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("backs generateChatClientMessageId with the same uniqueness contract", () => {
    const ids = Array.from({ length: 50 }, () => generateChatClientMessageId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("network status module API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetNetworkStatusForTests();
  });

  it("starts connected and notifies subscribers only on real transitions", () => {
    expect(isNetworkCurrentlyConnected()).toBe(true);
    expect(__getLastKnownNetworkConnected()).toBe(true);

    const seen: boolean[] = [];
    onNetworkStatusChange((connected) => seen.push(connected));

    // Repeating the current state is not a transition: no notification.
    dispatchNetworkStatus(true);
    expect(seen).toEqual([]);

    dispatchNetworkStatus(false);
    expect(seen).toEqual([false]);
    expect(isNetworkCurrentlyConnected()).toBe(false);

    dispatchNetworkStatus(true);
    expect(seen).toEqual([false, true]);
    expect(isNetworkCurrentlyConnected()).toBe(true);
  });

  it("stops notifying after the unsubscribe function runs", () => {
    const seen: boolean[] = [];
    const unsubscribe = onNetworkStatusChange((connected) =>
      seen.push(connected),
    );

    unsubscribe();
    dispatchNetworkStatus(false);

    expect(seen).toEqual([]);
    // The cached module state still tracks the bridge transition; only the
    // subscriber notification is suppressed by unsubscribing.
    expect(isNetworkCurrentlyConnected()).toBe(false);
  });

  it("ignores malformed bridge events instead of flipping connectivity", () => {
    const seen: boolean[] = [];
    onNetworkStatusChange((connected) => seen.push(connected));

    dispatchNetworkStatus("yes");
    dispatchNetworkStatus(undefined);
    document.dispatchEvent(new CustomEvent(NETWORK_STATUS_CHANGE_EVENT));
    document.dispatchEvent(new Event(NETWORK_STATUS_CHANGE_EVENT));

    expect(seen).toEqual([]);
    expect(__getLastKnownNetworkConnected()).toBe(true);
  });

  it("resets cached state and drops subscribers on the test-only reset", () => {
    const seen: boolean[] = [];
    onNetworkStatusChange((connected) => seen.push(connected));

    dispatchNetworkStatus(false);
    expect(__getLastKnownNetworkConnected()).toBe(false);

    __resetNetworkStatusForTests();
    expect(__getLastKnownNetworkConnected()).toBe(true);

    dispatchNetworkStatus(false);
    expect(seen).toEqual([false]);
    expect(__getLastKnownNetworkConnected()).toBe(false);
  });
});

describe("StreamGenerationError", () => {
  it("carries the gate fields and names itself for downstream guards", () => {
    const error = new StreamGenerationError({
      message: "generation failed",
      failureKind: "no_provider",
      accountConnect: { provider: "openrouter" } as never,
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("generation failed");
    expect(error.name).toBe("StreamGenerationError");
    expect(error.failureKind).toBe("no_provider");
    expect(error.accountConnect).toEqual({ provider: "openrouter" });
  });

  it("leaves the structured fields undefined when absent", () => {
    const error = new StreamGenerationError({ message: "boom" });

    expect(error.failureKind).toBeUndefined();
    expect(error.accountConnect).toBeUndefined();
  });

  it("accepts StreamGenerationError instances and rejects everything else", () => {
    const error = new StreamGenerationError({ message: "x" });
    class Other extends Error {}

    expect(isStreamGenerationError(error)).toBe(true);
    expect(isStreamGenerationError(new Error("plain"))).toBe(false);
    expect(isStreamGenerationError(new Other("sub"))).toBe(false);
    expect(isStreamGenerationError(null)).toBe(false);
    expect(isStreamGenerationError(undefined)).toBe(false);
    expect(isStreamGenerationError("generation failed")).toBe(false);
  });
});

describe("assistant text normalization", () => {
  let client: ElizaClient;

  beforeEach(() => {
    client = new ElizaClient("https://agent.example.test");
  });

  it("passes ordinary replies through trimmed and whitespace-tidied", () => {
    expect(client.normalizeAssistantText("  Hello world.  ")).toBe(
      "Hello world.",
    );
  });

  it("unwraps a leaked reply-payload object into the user-facing reply", () => {
    expect(client.normalizeAssistantText('{"reply":"107"}')).toBe("107");
    expect(
      client.normalizeAssistantText(
        '{"shouldRespond":"RESPOND","contexts":["simple"],"replyText":"Hello there"}',
      ),
    ).toBe("Hello there");
  });

  it("strips stage directions from otherwise usable replies", () => {
    expect(client.normalizeAssistantText("_blushes_ Hi there.")).toBe(
      "Hi there.",
    );
    expect(client.normalizeAssistantText("Hello! *waves* I am here.")).toBe(
      "Hello! I am here.",
    );
  });

  it("maps blanks and no-response variants to the generic notice", () => {
    expect(client.normalizeAssistantText("")).toBe(GENERIC_NO_RESPONSE_TEXT);
    expect(client.normalizeAssistantText("   ")).toBe(GENERIC_NO_RESPONSE_TEXT);
    expect(client.normalizeAssistantText("no response")).toBe(
      GENERIC_NO_RESPONSE_TEXT,
    );
    expect(client.normalizeAssistantText("(No Response)")).toBe(
      GENERIC_NO_RESPONSE_TEXT,
    );
  });

  it("returns empty rather than the notice for stripped-to-nothing content", () => {
    expect(client.normalizeAssistantText("*smiles*")).toBe("");
  });

  it("treats non-string input as a missing reply", () => {
    expect(client.normalizeAssistantText(undefined as unknown as string)).toBe(
      GENERIC_NO_RESPONSE_TEXT,
    );
  });

  it("keeps greetings quiet instead of substituting the generic notice", () => {
    expect(client.normalizeGreetingText("")).toBe("");
    expect(client.normalizeGreetingText("   ")).toBe("");
    expect(client.normalizeGreetingText("(no response)")).toBe("");
    expect(client.normalizeGreetingText(" Hello! _waves_ ")).toBe("Hello!");
  });
});

describe("ElizaClient.sendWsMessage offline queue", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    __resetNetworkStatusForTests();
  });

  it("stamps a msgId on queued frames and preserves caller-supplied ones", async () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test");
    client.connectWs();

    client.sendWsMessage({ type: "agent_event" });
    client.sendWsMessage({ type: "other", msgId: "caller-id" });

    openSocket(instances);
    const frames = sentFrames(instances[0]).filter(
      (frame) => frame.type !== "auth",
    );

    expect(frames.map((frame) => frame.type)).toEqual(["agent_event", "other"]);
    const stamped = frames[0].msgId;
    expect(typeof stamped).toBe("string");
    expect((stamped as string).length).toBeGreaterThan(0);
    expect(frames[1].msgId).toBe("caller-id");
  });

  it("sends immediately without queueing once the socket is open", () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test");
    client.connectWs();

    openSocket(instances);
    client.sendWsMessage({ type: "ping" });

    const frames = sentFrames(instances[0]);
    expect(frames).toHaveLength(1);
    expect(frames[0].type).toBe("ping");
    expect(typeof frames[0].msgId).toBe("string");
  });

  it("keeps only the newest active-conversation update while offline", async () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test");
    client.connectWs();

    client.sendWsMessage({ type: "active-conversation", n: 1 });
    client.sendWsMessage({ type: "status", n: 2 });
    client.sendWsMessage({ type: "active-conversation", n: 3 });

    openSocket(instances);
    const frames = sentFrames(instances[0]);

    expect(frames.map((frame) => frame.n)).toEqual([2, 3]);
    expect(frames.every((frame) => typeof frame.msgId === "string")).toBe(true);
  });

  it("caps the offline queue at 32 frames and drops the oldest first", async () => {
    const instances = stubWebSocketWithInstances();
    const client = new ElizaClient("https://agent.example.test");
    client.connectWs();

    for (let i = 0; i < 34; i++) {
      client.sendWsMessage({ type: "queued", n: i });
    }

    openSocket(instances);
    const frames = sentFrames(instances[0]);

    expect(frames).toHaveLength(32);
    expect(frames[0].n).toBe(2);
    expect(frames[31].n).toBe(33);
  });
});

describe("replayable WS event backlog", () => {
  it("replays at most the newest 8 backlogged navigation frames to a late handler", async () => {
    const client = new ElizaClient("https://agent.example.test");

    for (let i = 0; i < 10; i++) {
      client.deliverWsMessageForTest({
        type: "shell:navigate:view",
        n: i,
      });
    }

    const received: Record<string, unknown>[] = [];
    client.onWsEvent("shell:navigate:view", (data) => received.push(data));
    await flushMicrotasks();

    expect(received).toHaveLength(8);
    expect(received[0].n).toBe(2);
    expect(received[7].n).toBe(9);
  });

  it("drains the backlog after replay so a second late handler gets nothing", async () => {
    const client = new ElizaClient("https://agent.example.test");
    client.deliverWsMessageForTest({
      type: "shell:navigate:view",
      viewId: "settings",
    });

    const first: Record<string, unknown>[] = [];
    client.onWsEvent("shell:navigate:view", (data) => first.push(data));
    await flushMicrotasks();

    const second: Record<string, unknown>[] = [];
    client.onWsEvent("shell:navigate:view", (data) => second.push(data));
    await flushMicrotasks();

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });
});

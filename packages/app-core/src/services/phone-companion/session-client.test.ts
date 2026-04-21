import { describe, expect, it, vi } from "vitest";
import {
  decodePairingPayload,
  type InputEvent,
  SessionClient,
  type TouchGesture,
  type TouchSample,
  touchToInput,
} from "./session-client";

// ---- WebSocket mock ----------------------------------------------------------

interface ListenerMap {
  open: ((ev: Event) => void)[];
  close: ((ev: CloseEvent) => void)[];
  error: ((ev: Event) => void)[];
  message: ((ev: MessageEvent) => void)[];
}

class MockWebSocket {
  sent: string[] = [];
  closed = false;
  readonly listeners: ListenerMap = {
    open: [],
    close: [],
    error: [],
    message: [],
  };
  constructor(public readonly url: string) {}
  addEventListener<K extends keyof ListenerMap>(
    type: K,
    cb: ListenerMap[K][number],
  ): void {
    // @ts-expect-error narrowed per-union slot access
    this.listeners[type].push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    for (const cb of this.listeners.close) {
      cb({ code: 1000, wasClean: true } as CloseEvent);
    }
  }
  fireOpen(): void {
    for (const cb of this.listeners.open) cb({} as Event);
  }
  fireMessage(data: unknown): void {
    for (const cb of this.listeners.message) {
      cb({ data } as MessageEvent);
    }
  }
  fireError(): void {
    for (const cb of this.listeners.error) cb({} as Event);
  }
}

// ---- SessionClient -----------------------------------------------------------

describe("SessionClient", () => {
  it("transitions idle → connecting → open on socket open", () => {
    const socket = new MockWebSocket("wss://example/input");
    const client = new SessionClient(() => socket as unknown as WebSocket);
    const states: string[] = [];
    client.on("state", (s) => states.push(s));

    client.connect("wss://example/input", "token-xyz");
    expect(client.getState()).toBe("connecting");
    socket.fireOpen();
    expect(client.getState()).toBe("open");
    expect(states).toEqual(["connecting", "open"]);
  });

  it("appends token as a query parameter", () => {
    let captured = "";
    const client = new SessionClient((url) => {
      captured = url;
      return new MockWebSocket(url) as unknown as WebSocket;
    });
    client.connect("wss://example/input", "tok 1&2");
    expect(captured).toBe("wss://example/input?token=tok%201%262");

    const client2 = new SessionClient((url) => {
      captured = url;
      return new MockWebSocket(url) as unknown as WebSocket;
    });
    client2.connect("wss://example/input?foo=bar", "abc");
    expect(captured).toBe("wss://example/input?foo=bar&token=abc");
  });

  it("sends input events as JSON only while open", () => {
    const socket = new MockWebSocket("wss://example/input");
    const client = new SessionClient(() => socket as unknown as WebSocket);
    client.connect("wss://example/input", "t");
    // Not yet open — should drop.
    client.sendInput({ type: "mouse-click", x: 1, y: 2, button: "left" });
    expect(socket.sent).toEqual([]);

    socket.fireOpen();
    client.sendInput({ type: "mouse-click", x: 10, y: 20, button: "left" });
    expect(socket.sent).toEqual([
      JSON.stringify({ type: "mouse-click", x: 10, y: 20, button: "left" }),
    ]);
  });

  it("ignores reconnect while already connected", () => {
    const factory = vi.fn(
      (url: string) => new MockWebSocket(url) as unknown as WebSocket,
    );
    const client = new SessionClient(factory);
    client.connect("wss://example/input", "t");
    client.connect("wss://example/input", "t");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("transitions to closed on close()", () => {
    const socket = new MockWebSocket("wss://example/input");
    const client = new SessionClient(() => socket as unknown as WebSocket);
    client.connect("wss://example/input", "t");
    socket.fireOpen();
    client.close();
    expect(client.getState()).toBe("closed");
    expect(socket.closed).toBe(true);
  });

  it("emits error events", () => {
    const socket = new MockWebSocket("wss://example/input");
    const client = new SessionClient(() => socket as unknown as WebSocket);
    client.connect("wss://example/input", "t");
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e));
    socket.fireError();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain("WebSocket");
  });

  it("forwards messages to listeners", () => {
    const socket = new MockWebSocket("wss://example/input");
    const client = new SessionClient(() => socket as unknown as WebSocket);
    client.connect("wss://example/input", "t");
    socket.fireOpen();
    const received: unknown[] = [];
    client.on("message", (m) => received.push(m));
    socket.fireMessage("hello");
    expect(received).toEqual(["hello"]);
  });
});

// ---- touchToInput ------------------------------------------------------------

function sample(x: number, y: number, t: number, pointerId = 0): TouchSample {
  return { x, y, t, pointerId };
}

function gesture(
  pointers: readonly (readonly TouchSample[])[],
  ended = true,
): TouchGesture {
  return { pointers, ended };
}

describe("touchToInput", () => {
  it("single-finger tap → left click", () => {
    const result = touchToInput(
      gesture([[sample(100, 200, 0), sample(101, 200, 50)]]),
    );
    const expected: InputEvent[] = [
      { type: "mouse-click", x: 101, y: 200, button: "left" },
    ];
    expect(result).toEqual(expected);
  });

  it("single-finger long press (>= 500ms, minimal movement) → right click", () => {
    const result = touchToInput(
      gesture([[sample(50, 60, 0), sample(51, 61, 600)]]),
    );
    expect(result).toEqual([
      { type: "mouse-click", x: 51, y: 61, button: "right" },
    ]);
  });

  it("two-finger tap → middle click", () => {
    const result = touchToInput(
      gesture([
        [sample(100, 100, 0, 0), sample(101, 101, 80, 0)],
        [sample(140, 140, 0, 1), sample(141, 141, 80, 1)],
      ]),
    );
    expect(result).toEqual([
      { type: "mouse-click", x: 101, y: 101, button: "middle" },
    ]);
  });

  it("single-finger pan (> tap slop) → mouse drag", () => {
    const result = touchToInput(
      gesture([
        [sample(100, 100, 0), sample(140, 180, 50), sample(200, 250, 120)],
      ]),
    );
    expect(result).toEqual([
      { type: "mouse-drag", fromX: 100, fromY: 100, toX: 200, toY: 250 },
    ]);
  });

  it("returns [] for gestures that are not ended", () => {
    const result = touchToInput(
      gesture([[sample(0, 0, 0), sample(1, 1, 10)]], false),
    );
    expect(result).toEqual([]);
  });

  it("returns [] for empty gesture", () => {
    expect(touchToInput(gesture([]))).toEqual([]);
  });

  it("respects custom tapSlopPx and longPressMs", () => {
    // Movement of 10px is not a tap under slop=5 but is under slop=20.
    const strict = touchToInput(
      gesture([[sample(0, 0, 0), sample(10, 0, 100)]]),
      { tapSlopPx: 5 },
    );
    expect(strict[0].type).toBe("mouse-drag");

    const lax = touchToInput(gesture([[sample(0, 0, 0), sample(10, 0, 100)]]), {
      tapSlopPx: 20,
      longPressMs: 50,
    });
    expect(lax[0]).toEqual({
      type: "mouse-click",
      x: 10,
      y: 0,
      button: "right",
    });
  });
});

// ---- decodePairingPayload ----------------------------------------------------

describe("decodePairingPayload", () => {
  it("decodes a valid base64(JSON) payload", () => {
    const payload = {
      agentId: "a1",
      pairingCode: "123456",
      ingressUrl: "wss://ingress.example/input",
      sessionToken: "tok",
    };
    const encoded =
      typeof btoa === "function"
        ? btoa(JSON.stringify(payload))
        : Buffer.from(JSON.stringify(payload)).toString("base64");
    expect(decodePairingPayload(encoded)).toEqual(payload);
  });

  it("throws on missing fields", () => {
    const bad =
      typeof btoa === "function"
        ? btoa(JSON.stringify({ agentId: "a1" }))
        : Buffer.from(JSON.stringify({ agentId: "a1" })).toString("base64");
    expect(() => decodePairingPayload(bad)).toThrow(/missing or non-string/);
  });

  it("throws on non-object JSON", () => {
    const bad =
      typeof btoa === "function"
        ? btoa(JSON.stringify(["not", "an", "object"]))
        : Buffer.from(JSON.stringify(["x"])).toString("base64");
    expect(() => decodePairingPayload(bad)).toThrow(/not an object/);
  });
});

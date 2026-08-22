/**
 * Verifies that replaced Baileys sockets cannot mutate the active connection
 * lifecycle through delayed connection-update events.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const sockets: FakeSocket[] = [];

class FakeSocket {
  readonly ev = new EventEmitter();
  readonly ws = { close: vi.fn() };
}

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  }),
  DisconnectReason: { loggedOut: 401, badSession: 405 },
}));

import makeWASocket from "@whiskeysockets/baileys";
import { BaileysConnection } from "./connection";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  sockets.length = 0;
});

describe("BaileysConnection socket replacement", () => {
  it("ignores a delayed close event from a replaced socket", async () => {
    vi.useFakeTimers();
    const authManager = {
      initialize: vi.fn(async () => ({})),
      save: vi.fn(async () => undefined),
    };
    const connection = new BaileysConnection(authManager as never);

    await connection.connect();
    await connection.connect();
    expect(makeWASocket).toHaveBeenCalledTimes(2);

    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(makeWASocket).toHaveBeenCalledTimes(2);
    expect(connection.getStatus()).toBe("connecting");
  });

  it("lets the active socket reconnect while a replaced socket is backing off", async () => {
    vi.useFakeTimers();
    const authManager = {
      initialize: vi.fn(async () => ({})),
      save: vi.fn(async () => undefined),
    };
    const connection = new BaileysConnection(authManager as never);

    await connection.connect();
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });

    await connection.connect();
    sockets[1]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(makeWASocket).toHaveBeenCalledTimes(3);
    expect(connection.getSocket()).toBe(sockets[2]);
  });

  it("cancels a queued reconnect when the same socket reopens", async () => {
    vi.useFakeTimers();
    const authManager = {
      initialize: vi.fn(async () => ({})),
      save: vi.fn(async () => undefined),
    };
    const connection = new BaileysConnection(authManager as never);

    await connection.connect();
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });
    sockets[0]?.ev.emit("connection.update", { connection: "open" });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(makeWASocket).toHaveBeenCalledTimes(1);
    expect(connection.getStatus()).toBe("open");
  });

  it("ignores credential and message events from a replaced socket", async () => {
    const authManager = {
      initialize: vi.fn(async () => ({})),
      save: vi.fn(async () => undefined),
    };
    const connection = new BaileysConnection(authManager as never);
    const messages = vi.fn();
    connection.on("messages", messages);

    await connection.connect();
    await connection.connect();
    sockets[0]?.ev.emit("creds.update", {});
    sockets[0]?.ev.emit("messages.upsert", { messages: ["stale"] });
    await Promise.resolve();

    expect(authManager.save).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();

    sockets[1]?.ev.emit("creds.update", {});
    sockets[1]?.ev.emit("messages.upsert", { messages: ["current"] });
    await Promise.resolve();

    expect(authManager.save).toHaveBeenCalledTimes(1);
    expect(messages).toHaveBeenCalledWith(["current"]);
  });

  it("reports an active credential persistence rejection", async () => {
    const failure = new Error("credential write failed");
    const authManager = {
      initialize: vi.fn(async () => ({})),
      save: vi.fn(async () => {
        throw failure;
      }),
    };
    const connection = new BaileysConnection(authManager as never);
    const reported = vi.fn();
    connection.on("error", reported);

    await connection.connect();
    sockets[0]?.ev.emit("creds.update", {});
    await Promise.resolve();
    await Promise.resolve();

    expect(reported).toHaveBeenCalledWith(failure);
  });
});

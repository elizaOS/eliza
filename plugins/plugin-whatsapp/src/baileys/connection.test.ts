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
});

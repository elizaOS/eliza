/**
 * Deterministically exercises pairing lifecycle ownership across stopped,
 * restarted, and replaced Baileys sockets.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const sockets: FakeSocket[] = [];

class FakeSocket {
  readonly ev = new EventEmitter();
  end = vi.fn();
  user = { id: "1234567890:1@s.whatsapp.net" };
}

vi.mock("@whiskeysockets/baileys", () => ({
  default: vi.fn(() => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  }),
  useMultiFileAuthState: vi.fn(async () => ({ state: {}, saveCreds: vi.fn() })),
  fetchLatestBaileysVersion: vi.fn(async () => ({ version: [2, 3000, 0] })),
  DisconnectReason: {
    loggedOut: 401,
    restartRequired: 515,
    timedOut: 408,
    connectionClosed: 428,
    connectionReplaced: 440,
  },
}));

const DISCONNECT_REASON = {
  loggedOut: 401,
  restartRequired: 515,
  timedOut: 408,
  connectionClosed: 428,
  connectionReplaced: 440,
};

vi.mock("qrcode", () => ({
  default: { toDataURL: vi.fn(async () => "data:image/png;base64,x") },
}));

vi.mock("@hapi/boom", () => ({ Boom: class Boom extends Error {} }));

vi.mock("pino", () => ({
  default: vi.fn(() => ({ level: "silent" })),
}));

import makeWASocket, { fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { WhatsAppPairingSession } from "./whatsapp-pairing";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  sockets.length = 0;
});

describe("WhatsAppPairingSession stop/restart race", () => {
  it("does not resurrect a socket when stop() runs during an in-flight restart", async () => {
    vi.useFakeTimers();

    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let versionCalls = 0;
    vi.mocked(fetchLatestBaileysVersion).mockImplementation(async () => {
      versionCalls++;
      if (versionCalls === 2) {
        // Second call happens inside the restart's start() -- hold it open
        // so stop() can run while start() is still mid-flight.
        await gate;
      }
      return { version: [2, 3000, 0] };
    });

    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
    });

    await session.start();
    expect(makeWASocket).toHaveBeenCalledTimes(1);

    // Transient close schedules a restart 3s out.
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DISCONNECT_REASON.restartRequired } },
      },
    });

    await vi.advanceTimersByTimeAsync(3000);
    // The restart's start() is now blocked inside the gated version fetch,
    // before it would otherwise create a second socket.
    expect(versionCalls).toBe(2);
    expect(makeWASocket).toHaveBeenCalledTimes(1);

    session.stop();
    releaseGate?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(makeWASocket).toHaveBeenCalledTimes(1);
  });

  it("still restarts normally when stop() is never called", async () => {
    vi.useFakeTimers();

    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
    });

    await session.start();
    expect(makeWASocket).toHaveBeenCalledTimes(1);

    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DISCONNECT_REASON.restartRequired } },
      },
    });

    await vi.advanceTimersByTimeAsync(3000);

    expect(makeWASocket).toHaveBeenCalledTimes(2);
  });

  it("does not let an older in-flight restart join a later explicit start", async () => {
    vi.useFakeTimers();

    let releaseRestart: (() => void) | undefined;
    const restartGate = new Promise<void>((resolve) => {
      releaseRestart = resolve;
    });
    let versionCalls = 0;
    vi.mocked(fetchLatestBaileysVersion).mockImplementation(async () => {
      versionCalls++;
      if (versionCalls === 2) await restartGate;
      return { version: [2, 3000, 0] };
    });

    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
    });
    await session.start();
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DISCONNECT_REASON.restartRequired } },
      },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(versionCalls).toBe(2);

    session.stop();
    await session.start();
    expect(makeWASocket).toHaveBeenCalledTimes(2);

    releaseRestart?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(makeWASocket).toHaveBeenCalledTimes(2);
  });

  it("ignores late close events from the socket a restart replaced", async () => {
    vi.useFakeTimers();

    const onEvent = vi.fn();
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent,
    });
    await session.start();
    const firstSocket = sockets[0];
    firstSocket?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DISCONNECT_REASON.restartRequired } },
      },
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(makeWASocket).toHaveBeenCalledTimes(2);

    firstSocket?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DISCONNECT_REASON.restartRequired } },
      },
    });
    firstSocket?.ev.emit("connection.update", { connection: "open" });
    await vi.advanceTimersByTimeAsync(3000);

    expect(makeWASocket).toHaveBeenCalledTimes(2);
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ status: "connected" }));
  });
});

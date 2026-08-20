/**
 * Deterministically exercises pairing lifecycle ownership across stopped,
 * restarted, and replaced Baileys sockets.
 */
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const sockets: FakeSocket[] = [];
const credentialSaves: ReturnType<typeof vi.fn>[] = [];

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
  useMultiFileAuthState: vi.fn(async () => {
    const saveCreds = vi.fn(async () => undefined);
    credentialSaves.push(saveCreds);
    return { state: {}, saveCreds };
  }),
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
import QRCode from "qrcode";
import { WhatsAppPairingSession } from "./whatsapp-pairing";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  sockets.length = 0;
  credentialSaves.length = 0;
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

  it("does not emit a QR whose generation finishes after stop()", async () => {
    let releaseQr: (() => void) | undefined;
    const qrGate = new Promise<void>((resolve) => {
      releaseQr = resolve;
    });
    vi.mocked(QRCode.toDataURL).mockImplementationOnce(async () => {
      await qrGate;
      return "data:image/png;base64,late";
    });
    const onEvent = vi.fn();
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent,
    });
    await session.start();
    sockets[0]?.ev.emit("connection.update", { qr: "sensitive-qr" });
    await vi.waitFor(() => expect(QRCode.toDataURL).toHaveBeenCalledTimes(1));

    session.stop();
    releaseQr?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "whatsapp-qr" }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ status: "waiting_for_qr" }));
  });

  it("ignores credential updates from a socket that a restart replaced", async () => {
    vi.useFakeTimers();
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
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
    expect(sockets).toHaveLength(2);
    expect(credentialSaves).toHaveLength(2);

    firstSocket?.ev.emit("creds.update", { stale: true });
    sockets[1]?.ev.emit("creds.update", { current: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(credentialSaves[0]).not.toHaveBeenCalled();
    expect(credentialSaves[1]).toHaveBeenCalledTimes(1);
  });

  it("makes a synchronous close emitted by end() inert", async () => {
    vi.useFakeTimers();
    const onEvent = vi.fn();
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent,
    });
    await session.start();
    const socket = sockets[0];
    socket?.end.mockImplementation(() => {
      socket.ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: {
          error: { output: { statusCode: DISCONNECT_REASON.restartRequired } },
        },
      });
    });

    session.stop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(socket?.end).toHaveBeenCalledTimes(1);
    expect(makeWASocket).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ status: "disconnected" }));
  });
});

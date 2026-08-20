/**
 * Deterministically exercises pairing lifecycle ownership across stopped,
 * restarted, and replaced Baileys sockets.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const sockets: FakeSocket[] = [];
const credentialSaves: ReturnType<typeof vi.fn>[] = [];

class FakeSocket {
  readonly ev = new EventEmitter();
  end = vi.fn(async () => undefined);
  logout = vi.fn(async () => undefined);
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
import { WhatsAppPairingSession, whatsappLogout } from "./whatsapp-pairing";

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

    await session.stop();
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

    await session.stop();
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

    await session.stop();
    releaseQr?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: "whatsapp-qr" }));
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ status: "waiting_for_qr" }));
  });

  it("does not let an older QR conversion replace a newer QR from the same socket", async () => {
    let releaseOlderQr: (() => void) | undefined;
    const olderQrGate = new Promise<void>((resolve) => {
      releaseOlderQr = resolve;
    });
    vi.mocked(QRCode.toDataURL).mockImplementation(async (qr) => {
      if (qr === "older-qr") await olderQrGate;
      return `data:image/png;base64,${qr}`;
    });
    const onEvent = vi.fn();
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent,
    });
    await session.start();

    sockets[0]?.ev.emit("connection.update", { qr: "older-qr" });
    await vi.waitFor(() => expect(QRCode.toDataURL).toHaveBeenCalledTimes(1));
    sockets[0]?.ev.emit("connection.update", { qr: "newer-qr" });
    await vi.waitFor(() =>
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "whatsapp-qr",
          qrDataUrl: "data:image/png;base64,newer-qr",
        })
      )
    );

    releaseOlderQr?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    const qrEvents = onEvent.mock.calls
      .map(([event]) => event as { type: string; qrDataUrl?: string })
      .filter((event) => event.type === "whatsapp-qr");
    expect(qrEvents).toEqual([
      expect.objectContaining({ qrDataUrl: "data:image/png;base64,newer-qr" }),
    ]);
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

  it("persists an admitted credential update before a same-turn transient restart", async () => {
    vi.useFakeTimers();
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
    });
    await session.start();

    sockets[0]?.ev.emit("creds.update", { admitted: true });
    sockets[0]?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: DISCONNECT_REASON.restartRequired } },
      },
    });
    await vi.advanceTimersByTimeAsync(3000);

    expect(credentialSaves[0]).toHaveBeenCalledTimes(1);
    expect(credentialSaves).toHaveLength(2);
    expect(makeWASocket).toHaveBeenCalledTimes(2);
  });

  it("drains every admitted credential save before an explicit replacement", async () => {
    let releaseFirstSave: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
    });
    await session.start();
    credentialSaves[0]?.mockImplementationOnce(async () => {
      await firstSaveGate;
    });

    sockets[0]?.ev.emit("creds.update", { sequence: 1 });
    sockets[0]?.ev.emit("creds.update", { sequence: 2 });
    const replacement = session.start();
    await vi.waitFor(() => expect(credentialSaves[0]).toHaveBeenCalledTimes(1));
    expect(credentialSaves).toHaveLength(1);
    expect(makeWASocket).toHaveBeenCalledTimes(1);

    releaseFirstSave?.();
    await replacement;
    expect(credentialSaves[0]).toHaveBeenCalledTimes(2);
    expect(credentialSaves).toHaveLength(2);
    expect(makeWASocket).toHaveBeenCalledTimes(2);
  });

  it("drains an admitted credential save before loading replacement auth state", async () => {
    let releaseOldSave: (() => void) | undefined;
    const oldSaveGate = new Promise<void>((resolve) => {
      releaseOldSave = resolve;
    });
    const saveOrder: string[] = [];
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
    });
    await session.start();
    credentialSaves[0]?.mockImplementationOnce(async () => {
      await oldSaveGate;
      saveOrder.push("old");
    });

    sockets[0]?.ev.emit("creds.update", { admitted: true });
    await vi.waitFor(() => expect(credentialSaves[0]).toHaveBeenCalledTimes(1));
    const replacement = session.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(makeWASocket).toHaveBeenCalledTimes(1);
    expect(credentialSaves).toHaveLength(1);

    releaseOldSave?.();
    await replacement;
    expect(makeWASocket).toHaveBeenCalledTimes(2);
    expect(credentialSaves).toHaveLength(2);

    credentialSaves[1]?.mockImplementationOnce(async () => {
      saveOrder.push("new");
    });
    sockets[1]?.ev.emit("creds.update", { current: true });
    await vi.waitFor(() => expect(credentialSaves[1]).toHaveBeenCalledTimes(1));
    expect(saveOrder).toEqual(["old", "new"]);
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
    socket?.end.mockImplementation(async () => {
      socket.ev.emit("connection.update", {
        connection: "close",
        lastDisconnect: {
          error: { output: { statusCode: DISCONNECT_REASON.restartRequired } },
        },
      });
    });

    await session.stop();
    await vi.advanceTimersByTimeAsync(3000);

    expect(socket?.end).toHaveBeenCalledTimes(1);
    expect(makeWASocket).toHaveBeenCalledTimes(1);
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ status: "disconnected" }));
  });

  it("does not finish stop until the asynchronous socket teardown settles", async () => {
    let releaseEnd: (() => void) | undefined;
    const endGate = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
    });
    await session.start();
    sockets[0]?.end.mockImplementationOnce(async () => {
      await endGate;
    });

    let stopped = false;
    const stopping = session.stop().then(() => {
      stopped = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopped).toBe(false);

    releaseEnd?.();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("observes an asynchronous socket teardown rejection", async () => {
    const session = new WhatsAppPairingSession({
      authDir: "/tmp/whatsapp-pairing-test",
      accountId: "acct-1",
      onEvent: vi.fn(),
    });
    await session.start();
    sockets[0]?.end.mockRejectedValueOnce(new Error("teardown failed"));

    await expect(session.stop()).resolves.toBeUndefined();
    expect(sockets[0]?.end).toHaveBeenCalledTimes(1);
  });
});

describe("whatsappLogout teardown ordering", () => {
  it("settles the logout socket before deleting its authentication directory", async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "whatsapp-logout-test-"));
    const authDir = path.join(workspaceDir, "whatsapp-auth", "acct-1");
    await mkdir(authDir, { recursive: true });
    await writeFile(path.join(authDir, "creds.json"), "{}");
    let releaseEnd: (() => void) | undefined;
    const endGate = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });

    try {
      let finished = false;
      const loggingOut = whatsappLogout(workspaceDir, "acct-1").then(() => {
        finished = true;
      });
      await vi.waitFor(() => expect(sockets).toHaveLength(1));
      sockets[0]?.end.mockImplementationOnce(async () => {
        await endGate;
      });
      sockets[0]?.ev.emit("connection.update", { connection: "open" });
      await vi.waitFor(() => expect(sockets[0]?.logout).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(finished).toBe(false);
      expect(fs.existsSync(authDir)).toBe(true);

      releaseEnd?.();
      await loggingOut;
      expect(fs.existsSync(authDir)).toBe(false);
    } finally {
      releaseEnd?.();
      await rm(workspaceDir, { recursive: true, force: true });
    }
  });
});

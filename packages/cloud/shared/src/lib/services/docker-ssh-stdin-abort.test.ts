/**
 * Deterministic SSH channel faults exercise cancellation and receipt fencing
 * in the real client; the separate loopback suite covers native SSH framing.
 */
import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { DockerSSHClient } from "./docker-ssh";

let connectingSession: FakeConnectingSshClient | undefined;

class FakeConnectingSshClient extends EventEmitter {
  connectCalls = 0;
  destroyCalls = 0;

  constructor() {
    super();
    connectingSession = this;
  }

  connect(): void {
    this.connectCalls += 1;
  }

  destroy(): this {
    this.destroyCalls += 1;
    return this;
  }
}

mock.module("ssh2", () => ({ Client: FakeConnectingSshClient }));

class FakeClientChannel extends EventEmitter {
  readonly stderr = new EventEmitter();
  closeCalls = 0;
  destroyCalls = 0;
  endedWith: Buffer | undefined;
  writtenWith: Buffer | undefined;

  close(): void {
    this.closeCalls += 1;
  }

  destroy(): this {
    this.destroyCalls += 1;
    return this;
  }

  end(input: Buffer): void {
    this.endedWith = input;
  }

  write(input: Buffer): boolean {
    this.writtenWith = input;
    return true;
  }
}

interface FakeSshSession {
  execCalls: number;
  destroyCalls: number;
  exec(
    command: string,
    callback: (error: Error | undefined, channel: FakeClientChannel) => void,
  ): void;
  destroy(): void;
}

function makeConnectedClient(session: FakeSshSession): DockerSSHClient {
  const client = new DockerSSHClient({
    hostname: "restore-node.example.test",
    privateKey: Buffer.from("unused"),
    hostKeyFingerprint: "test-host-key-fingerprint",
  });
  Object.defineProperties(client, {
    connected: { configurable: true, value: true, writable: true },
    client: { configurable: true, value: session, writable: true },
  });
  return client;
}

async function requireError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    // error-policy:J1 The assertion boundary requires an explicit rejection.
    if (error instanceof Error) return error;
    throw new Error("Expected an Error rejection");
  }
  throw new Error("Expected promise to reject");
}

function makeCallerAbortReason(message: string): Error {
  const reason = new Error(message);
  reason.name = "AbortError";
  return reason;
}

describe("DockerSSHClient.connect cancellation", () => {
  test("preserves the exact reason of a pre-aborted signal", async () => {
    const client = new DockerSSHClient({
      hostname: "restore-node.example.test",
      privateKey: Buffer.from("unused"),
      hostKeyFingerprint: "test-host-key-fingerprint",
    });
    const controller = new AbortController();
    const reason = makeCallerAbortReason("cancelled before SSH connect");
    controller.abort(reason);

    const error = await requireError(client.connect(controller.signal));

    expect(error).toBe(reason);
    expect(client.isConnected).toBe(false);
  });

  test("preserves the exact reason when aborted while connect is in flight", async () => {
    connectingSession = undefined;
    const client = new DockerSSHClient({
      hostname: "restore-node.example.test",
      privateKey: Buffer.from("unused"),
      hostKeyFingerprint: "test-host-key-fingerprint",
    });
    const controller = new AbortController();
    const reason = makeCallerAbortReason("cancelled during SSH connect");

    const promise = client.connect(controller.signal);

    for (let attempt = 0; attempt < 100 && !connectingSession; attempt += 1) {
      await Bun.sleep(1);
    }
    if (!connectingSession) throw new Error("Expected SSH connection attempt to start");
    expect(connectingSession.connectCalls).toBe(1);

    controller.abort(reason);
    const error = await requireError(promise);

    expect(error).toBe(reason);
    expect(connectingSession.destroyCalls).toBe(1);
    expect(client.isConnected).toBe(false);
  });
});

describe("DockerSSHClient.execStdinAbortable", () => {
  function receiptExchange(expected = "a".repeat(64)) {
    const channel = new FakeClientChannel();
    const session: FakeSshSession = {
      execCalls: 0,
      destroyCalls: 0,
      exec(_command, callback) {
        this.execCalls += 1;
        callback(undefined, channel);
      },
      destroy() {
        this.destroyCalls += 1;
      },
    };
    const controller = new AbortController();
    const input = Buffer.from("private restore frame");
    const promise = makeConnectedClient(session).execStdinAbortable(
      "restore-worker",
      input,
      controller.signal,
      5_000,
      expected,
    );
    return { channel, session, controller, input, promise };
  }

  test("keeps framed stdin open and requires the complete receipt plus exit zero", async () => {
    const { channel, input, promise } = receiptExchange();
    expect(channel.writtenWith).toBe(input);
    expect(channel.endedWith).toBeUndefined();
    let settled = false;
    void promise.then(() => {
      settled = true;
    });
    for (const text of ["a".repeat(17), "a".repeat(47)]) {
      const chunk = Buffer.from(text);
      channel.emit("data", chunk);
      expect(chunk.every((byte) => byte === 0)).toBe(true);
    }
    await Promise.resolve();
    expect(settled).toBe(false);
    channel.emit("close", 0);
    await promise;
    expect(settled).toBe(true);
  });

  test.each([
    ["short", "a".repeat(63), false, 0],
    ["wrong", "b".repeat(64), false, 0],
    ["trailing", `${"a".repeat(64)}\n`, false, 0],
    ["stderr", "private restore frame", true, 0],
    ["failed exit", "a".repeat(64), false, 1],
  ] as const)(
    "rejects %s acknowledgements without reflecting remote bytes",
    async (_name, data, stderr, code) => {
      const { channel, promise } = receiptExchange();
      const chunk = Buffer.from(data);
      (stderr ? channel.stderr : channel).emit("data", chunk);
      channel.emit("close", code);
      const error = await requireError(promise);
      expect(chunk.every((byte) => byte === 0)).toBe(true);
      expect(error.message).not.toContain(data);
    },
  );

  test("abort wins even after the full receipt arrived", async () => {
    const { channel, controller, promise } = receiptExchange();
    channel.emit("data", Buffer.from("a".repeat(64)));
    const reason = makeCallerAbortReason("lease lost before exit");
    controller.abort(reason);
    channel.emit("close", 0);
    expect(await requireError(promise)).toBe(reason);
  });

  test.each(["", "A".repeat(64), `${"a".repeat(64)}\n`, "a".repeat(65)])(
    "rejects malformed expected receipt before opening a channel (%s)",
    async (expected) => {
      const { session, channel, promise } = receiptExchange(expected);
      expect((await requireError(promise)).message).toBe("Invalid expected SSH restore receipt");
      expect(session.execCalls).toBe(0);
      expect(channel.writtenWith).toBeUndefined();
    },
  );

  test("preserves a pre-aborted signal reason before opening an SSH exec channel", async () => {
    const channel = new FakeClientChannel();
    const session: FakeSshSession = {
      execCalls: 0,
      destroyCalls: 0,
      exec(_command, callback) {
        this.execCalls += 1;
        callback(undefined, channel);
      },
      destroy() {
        this.destroyCalls += 1;
      },
    };
    const client = makeConnectedClient(session);
    const controller = new AbortController();
    const reason = makeCallerAbortReason("cancelled before stdin transfer");
    controller.abort(reason);

    const error = await requireError(
      client.execStdinAbortable(
        "secret-command --redacted",
        Buffer.from("secret"),
        controller.signal,
      ),
    );

    expect(error).toBe(reason);
    expect(error.name).toBe("AbortError");
    expect(error.message).not.toContain("secret-command");
    expect(error.message).not.toContain("secret");
    expect(session.execCalls).toBe(0);
    expect(channel.endedWith).toBeUndefined();
  });

  test("does not settle an in-flight abort until the SSH channel is closed", async () => {
    const channel = new FakeClientChannel();
    const session: FakeSshSession = {
      execCalls: 0,
      destroyCalls: 0,
      exec(_command, callback) {
        this.execCalls += 1;
        callback(undefined, channel);
      },
      destroy() {
        this.destroyCalls += 1;
      },
    };
    const client = makeConnectedClient(session);
    const controller = new AbortController();
    const reason = makeCallerAbortReason("cancelled during stdin transfer");
    const input = Buffer.from("vault-passphrase-frame");
    let outcome = "pending";

    const promise = client.execStdinAbortable(
      "secret-command --redacted",
      input,
      controller.signal,
    );
    void promise.then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );

    expect(channel.endedWith).toBe(input);
    controller.abort(reason);
    await Promise.resolve();

    expect(channel.closeCalls).toBe(1);
    expect(channel.destroyCalls).toBe(1);
    expect(outcome).toBe("pending");

    channel.emit("close", 0);
    const error = await requireError(promise);
    expect(error).toBe(reason);
    expect(error.name).toBe("AbortError");
    expect(outcome).toBe("rejected");
    expect(session.destroyCalls).toBe(0);
  });

  test("does not destroy the session when channel cancellation closes synchronously", async () => {
    const channel = new FakeClientChannel();
    const session: FakeSshSession = {
      execCalls: 0,
      destroyCalls: 0,
      exec(_command, callback) {
        this.execCalls += 1;
        callback(undefined, channel);
      },
      destroy() {
        this.destroyCalls += 1;
      },
    };
    channel.close = () => {
      channel.closeCalls += 1;
      channel.emit("close", null);
    };
    const client = makeConnectedClient(session);
    const controller = new AbortController();
    const promise = client.execStdinAbortable(
      "secret-command --redacted",
      Buffer.from("secret"),
      controller.signal,
    );

    controller.abort();
    const error = await requireError(promise);
    expect(error.name).toBe("AbortError");
    await Bun.sleep(1_100);
    expect(session.destroyCalls).toBe(0);
  });

  test("destroys the dedicated SSH session when an aborted channel never closes", async () => {
    const channel = new FakeClientChannel();
    const session: FakeSshSession = {
      execCalls: 0,
      destroyCalls: 0,
      exec(_command, callback) {
        this.execCalls += 1;
        callback(undefined, channel);
      },
      destroy() {
        this.destroyCalls += 1;
      },
    };
    const client = makeConnectedClient(session);
    const controller = new AbortController();
    const promise = client.execStdinAbortable(
      "secret-command --redacted",
      Buffer.from("secret"),
      controller.signal,
    );

    controller.abort();
    const error = await requireError(promise);

    expect(error.name).toBe("AbortError");
    expect(channel.closeCalls).toBe(1);
    expect(channel.destroyCalls).toBe(1);
    expect(session.destroyCalls).toBe(1);
    expect(client.isConnected).toBe(false);
  });

  test("destroys a late channel without ever handing it stdin after abort", async () => {
    const lateChannel = new FakeClientChannel();
    let openCallback: ((error: Error | undefined, channel: FakeClientChannel) => void) | undefined;
    const session: FakeSshSession = {
      execCalls: 0,
      destroyCalls: 0,
      exec(_command, callback) {
        this.execCalls += 1;
        openCallback = callback;
      },
      destroy() {
        this.destroyCalls += 1;
      },
    };
    const client = makeConnectedClient(session);
    const controller = new AbortController();
    const promise = client.execStdinAbortable(
      "secret-command --redacted",
      Buffer.from("secret"),
      controller.signal,
    );

    controller.abort();
    const error = await requireError(promise);
    expect(error.name).toBe("AbortError");
    expect(session.destroyCalls).toBe(1);

    if (!openCallback) throw new Error("Expected SSH exec callback to be captured");
    openCallback(undefined, lateChannel);
    expect(lateChannel.destroyCalls).toBe(1);
    expect(lateChannel.endedWith).toBeUndefined();
  });

  test("discards bounded remote output on a successful close", async () => {
    const channel = new FakeClientChannel();
    const session: FakeSshSession = {
      execCalls: 0,
      destroyCalls: 0,
      exec(_command, callback) {
        this.execCalls += 1;
        callback(undefined, channel);
      },
      destroy() {
        this.destroyCalls += 1;
      },
    };
    const client = makeConnectedClient(session);
    const controller = new AbortController();
    const promise = client.execStdinAbortable(
      "receipt-command",
      Buffer.from("frame"),
      controller.signal,
    );

    channel.emit("data", Buffer.from("receipt-ok\n"));
    channel.emit("close", 0);

    expect(await promise).toBeUndefined();
    expect(session.destroyCalls).toBe(0);
  });

  test("never reflects remote output in a non-zero exit error", async () => {
    const channel = new FakeClientChannel();
    const session: FakeSshSession = {
      execCalls: 0,
      destroyCalls: 0,
      exec(_command, callback) {
        this.execCalls += 1;
        callback(undefined, channel);
      },
      destroy() {
        this.destroyCalls += 1;
      },
    };
    const client = makeConnectedClient(session);
    const controller = new AbortController();
    const promise = client.execStdinAbortable(
      "secret-command --redacted",
      Buffer.from("secret"),
      controller.signal,
    );

    const reflectedOutput = Buffer.from("reflected-secret");
    channel.stderr.emit("data", reflectedOutput);
    channel.emit("close", 17);

    const error = await requireError(promise);
    expect(reflectedOutput.every((byte) => byte === 0)).toBe(true);
    expect(error.message).toContain("exited with code 17");
    expect(error.message).not.toContain("reflected-secret");
    expect(error.message).not.toContain("secret-command");
  });
});

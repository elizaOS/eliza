import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BrowserDispatchFailure } from "./dispatch-types";
import { NativeSocketBrowserTarget } from "./native-socket-target";

it.skipIf(process.platform !== "linux")(
  "reports expected disconnection only once until a verified profile reconnects",
  async () => {
    const diagnostics: Error[] = [];
    const target = new NativeSocketBrowserTarget((error) =>
      diagnostics.push(error),
    );
    const clients = new Set<Socket>();
    const server = createServer((socket) => {
      clients.add(socket);
      socket.once("close", () => clients.delete(socket));
      const hello = Buffer.from(
        JSON.stringify({
          type: "hello",
          protocol: 2,
          extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
          profileId: "test-profile",
          capabilities: ["list"],
        }),
      );
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(hello.length);
      socket.write(Buffer.concat([prefix, hello]));
    });
    let listening = false;
    try {
      await target.start({ ELIZA_PLATFORM: "android" });
      await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
      expect(diagnostics[0]).toBeInstanceOf(BrowserDispatchFailure);
      expect((diagnostics[0] as BrowserDispatchFailure).kind).toBe(
        "UNAVAILABLE",
      );
      await new Promise((resolve) => setTimeout(resolve, 3300));
      expect(diagnostics).toHaveLength(1);
      await new Promise<void>((resolve) =>
        server.listen("\0ai.elizaos.app.browser.native", resolve),
      );
      listening = true;
      await vi.waitFor(
        async () => expect(await target.available()).toBe(true),
        {
          timeout: 4000,
        },
      );
      for (const client of clients) client.destroy();
      await vi.waitFor(() => expect(diagnostics).toHaveLength(2));
      expect((diagnostics[1] as BrowserDispatchFailure).kind).toBe(
        "UNAVAILABLE",
      );
      expect(await target.available()).toBe(false);
    } finally {
      await target.stop();
      for (const client of clients) client.destroy();
      if (listening)
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  15000,
);

function socketFrames(socket: Socket) {
  const messages: Array<Record<string, unknown>> = [];
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      messages.push(
        JSON.parse(buffer.subarray(4, length + 4).toString("utf8")),
      );
      buffer = buffer.subarray(length + 4);
    }
  });
  const send = (frame: unknown) => {
    const data = Buffer.from(JSON.stringify(frame));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32LE(data.length);
    socket.write(Buffer.concat([prefix, data]));
  };
  return { messages, send };
}

it("acknowledges profile-bound liveness then rejects interrupted effects without replay on reconnect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-liveness-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {}, {
    registrationMs: 1000,
    heartbeatMs: 400,
  });
  const sockets: Socket[] = [];
  const peer = () => {
    const socket = createConnection(socketPath);
    sockets.push(socket);
    const frames = socketFrames(socket);
    frames.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "stable-profile",
      capabilities: ["list"],
      nonce: "hello-nonce",
    });
    return frames;
  };
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    const first = peer();
    await vi.waitFor(() =>
      expect(first.messages[0]).toEqual({
        type: "hello-ack",
        nonce: "hello-nonce",
        profileId: "stable-profile",
      }),
    );
    first.send({
      type: "ping",
      nonce: "probe-nonce",
      profileId: "stable-profile",
    });
    await vi.waitFor(() =>
      expect(first.messages[1]).toEqual({
        type: "pong",
        nonce: "probe-nonce",
        profileId: "stable-profile",
      }),
    );
    const command = target.execute({ subaction: "list" });
    const interrupted = expect(command).rejects.toMatchObject({
      kind: "UNCERTAIN_OUTCOME",
    });
    await vi.waitFor(() =>
      expect(
        first.messages.filter((value) => value.type === "command"),
      ).toHaveLength(1),
    );
    await interrupted;
    expect(await target.available()).toBe(false);
    const second = peer();
    await vi.waitFor(() => expect(second.messages[0]?.type).toBe("hello-ack"));
    expect(await target.available()).toBe(true);
    expect(target.getProfileId()).toBe("stable-profile");
    expect(second.messages.some((value) => value.type === "command")).toBe(
      false,
    );
    second.send({
      type: "ping",
      nonce: "other-probe",
      profileId: "wrong-profile",
    });
    await vi.waitFor(async () => expect(await target.available()).toBe(false));
  } finally {
    for (const socket of sockets) socket.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("expires a socket that never registers a profile", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-no-hello-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {}, {
    registrationMs: 40,
    heartbeatMs: 400,
  });
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    await new Promise<void>((resolve) => socket?.once("close", resolve));
    expect(await target.available()).toBe(false);
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("withdraws known-closed readiness before the asynchronous close event and refuses new dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-closed-readiness-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {});
  let socket: Socket | undefined;
  let stopping: Promise<void> | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const peer = socketFrames(socket);
    peer.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "stable-profile",
      capabilities: ["list"],
      nonce: "readiness-probe",
    });
    await vi.waitFor(() => expect(peer.messages[0]?.type).toBe("hello-ack"));
    expect(target.getProfileId()).toBe("stable-profile");
    // destroy() is synchronous; the close handler clearing cached registration is not.
    stopping = target.stop();
    expect(target.getProfileId()).toBeNull();
    const rejected = expect(
      target.execute({ subaction: "list" }),
    ).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
    expect(await target.available()).toBe(false);
    await rejected;
    await stopping;
    expect(
      peer.messages.filter((frame) => frame.type === "command"),
    ).toHaveLength(0);
  } finally {
    socket?.destroy();
    await (stopping ?? target.stop());
    await rm(directory, { recursive: true, force: true });
  }
});

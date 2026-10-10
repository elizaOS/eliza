import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { BrowserDispatchFailure } from "./dispatch-types";
import {
  androidNativeBrowserSocketPath,
  currentPageFromTabs,
  currentPageTitle,
  NativeSocketBrowserTarget,
} from "./native-socket-target";

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
      await target.start({
        ELIZA_PLATFORM: "android",
        ELIZA_BROWSER_ANDROID_APPLICATION: "org.example.browserfixture",
      });
      await vi.waitFor(() => expect(diagnostics).toHaveLength(1));
      expect(diagnostics[0]).toBeInstanceOf(BrowserDispatchFailure);
      expect((diagnostics[0] as BrowserDispatchFailure).kind).toBe(
        "UNAVAILABLE",
      );
      await new Promise((resolve) => setTimeout(resolve, 3300));
      expect(diagnostics).toHaveLength(1);
      await new Promise<void>((resolve) =>
        server.listen("\0org.example.browserfixture.browser.native", resolve),
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

it("negotiates cancellation and sends a fence for an aborted native request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-cancel-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {}, {
    registrationMs: 1000,
    heartbeatMs: 10000,
  });
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const peer = socketFrames(socket);
    peer.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "cancel-profile",
      capabilities: ["list", "cancel"],
      nonce: "hello",
    });
    await vi.waitFor(() => expect(peer.messages[0]?.type).toBe("hello-ack"));
    const controller = new AbortController();
    const running = target.execute(
      { subaction: "list" },
      { signal: controller.signal },
    );
    const rejected = expect(running).rejects.toMatchObject({
      kind: "UNCERTAIN_OUTCOME",
    });
    await vi.waitFor(() =>
      expect(peer.messages.some((message) => message.type === "command")).toBe(
        true,
      ),
    );
    const command = peer.messages.find((message) => message.type === "command");
    controller.abort();
    await rejected;
    await vi.waitFor(() =>
      expect(peer.messages).toContainEqual({ type: "cancel", id: command?.id }),
    );
    peer.send({
      type: "result",
      id: command?.id,
      ok: true,
      result: { tabs: [] },
    });
    await expect(
      target.execute({ subaction: "list" }, { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "STALE_REF" });
    expect(
      peer.messages.filter((message) => message.type === "command"),
    ).toHaveLength(1);
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("does not send a cancellable request to an older native peer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-no-cancel-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {}, {
    registrationMs: 1000,
    heartbeatMs: 10000,
  });
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const peer = socketFrames(socket);
    peer.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "old-profile",
      capabilities: ["list"],
      nonce: "hello",
    });
    await vi.waitFor(() => expect(peer.messages[0]?.type).toBe("hello-ack"));
    await expect(
      target.execute(
        { subaction: "list" },
        { signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ kind: "UNSUPPORTED" });
    expect(peer.messages.some((message) => message.type === "command")).toBe(
      false,
    );
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("sends host task bindings separately from scoped model commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-task-binding-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {});
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const frames = socketFrames(socket);
    frames.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "task-profile",
      capabilities: ["snapshot", "click", "task-bind"],
    });
    await vi.waitFor(async () => expect(await target.available()).toBe(true));
    const binding = {
      tabId: "1",
      bindingRevision: 1,
      actorId: "actor",
      accountId: "account",
      agentId: "agent",
      taskId: "task",
      epoch: 1,
      origin: "https://example.test",
      expiresAt: Date.now() + 60000,
      revoked: false,
      targets: [],
    };
    const bound = target.bindTask(binding);
    await vi.waitFor(() => expect(frames.messages).toHaveLength(1));
    expect(frames.messages[0]).toMatchObject({ type: "task-bind", binding });
    frames.send({
      type: "result",
      id: frames.messages[0].id,
      ok: true,
      result: { bound: true },
    });
    await expect(bound).resolves.toEqual({ bound: true });
    const taskContext = {
      actorId: "actor",
      accountId: "account",
      agentId: "agent",
      taskId: "task",
      epoch: 1,
    };
    const taskExpiresAt = Date.now() + 30000;
    const observed = target.execute(
      { subaction: "snapshot", id: "1" },
      { taskContext, taskExpiresAt },
    );
    await vi.waitFor(() => expect(frames.messages).toHaveLength(2));
    expect(frames.messages[1]).toMatchObject({
      type: "command",
      command: { subaction: "snapshot", id: "1", taskContext, taskExpiresAt },
    });
    frames.send({
      type: "result",
      id: frames.messages[1].id,
      ok: true,
      result: { frames: [] },
    });
    await expect(observed).resolves.toMatchObject({ subaction: "snapshot" });
    await expect(
      target.execute(
        {
          subaction: "click",
          id: "1",
          selector: "00000000-0000-0000-0000-000000000000:0:0",
        },
        { taskContext },
      ),
    ).rejects.toThrow(/action feedback/);
    expect(frames.messages).toHaveLength(2);
    await expect(
      target.execute({ subaction: "snapshot" }, { taskContext }),
    ).rejects.toMatchObject({ kind: "UNSUPPORTED" });
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("negotiates trusted task guidance and sends a cancellation fence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-task-guide-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {});
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const frames = socketFrames(socket);
    frames.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "guide-profile",
      capabilities: ["task-bind", "task-guide", "cancel"],
    });
    await vi.waitFor(async () => expect(await target.available()).toBe(true));
    const guidance = {
      tabId: "1",
      taskContext: {
        actorId: "actor",
        accountId: "account",
        agentId: "agent",
        taskId: "task",
        epoch: 1,
      },
      revision: 1,
      kind: "hide" as const,
    };
    const done = target.guideTask(guidance);
    await vi.waitFor(() => expect(frames.messages).toHaveLength(1));
    expect(frames.messages[0]).toMatchObject({ type: "task-guide", guidance });
    frames.send({
      type: "result",
      id: frames.messages[0].id,
      ok: true,
      result: { visible: false },
    });
    await expect(done).resolves.toEqual({ visible: false });
    const controller = new AbortController();
    const pending = target.guideTask(
      { ...guidance, revision: 2 },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toBeInstanceOf(
      BrowserDispatchFailure,
    );
    await vi.waitFor(() => expect(frames.messages).toHaveLength(2));
    controller.abort();
    await rejected;
    await vi.waitFor(() => expect(frames.messages).toHaveLength(3));
    expect(frames.messages[2]).toEqual({
      type: "cancel",
      id: frames.messages[1].id,
    });
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("sends a deadline-bound effect only to a feedback-capable peer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-action-feedback-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {});
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const frames = socketFrames(socket);
    frames.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "feedback",
      capabilities: ["click", "task-bind", "task-action-feedback"],
    });
    await vi.waitFor(async () => expect(await target.available()).toBe(true));
    const taskContext = {
      actorId: "actor",
      accountId: "account",
      agentId: "agent",
      taskId: "task",
      epoch: 1,
    };
    const taskExpiresAt = Date.now() + 10000;
    const executing = target.execute(
      {
        subaction: "click",
        id: "1",
        selector: "00000000-0000-0000-0000-000000000000:0:0",
      },
      { taskContext, taskExpiresAt },
    );
    await vi.waitFor(() => expect(frames.messages).toHaveLength(1));
    expect(frames.messages[0]).toMatchObject({
      type: "command",
      command: { subaction: "click", taskContext, taskExpiresAt },
    });
    frames.send({
      type: "result",
      id: frames.messages[0].id,
      ok: true,
      result: { dispatched: true },
    });
    await expect(executing).resolves.toMatchObject({ subaction: "click" });
    // The preview sentence comes only from trusted options, never the command.
    const worded = target.execute(
      {
        subaction: "click",
        id: "1",
        selector: "00000000-0000-0000-0000-000000000000:0:0",
        actionText: "Page text cannot word this.",
      } as never,
      {
        taskContext,
        taskExpiresAt,
        actionText: "I will choose your saved Visa.",
      },
    );
    await vi.waitFor(() => expect(frames.messages).toHaveLength(2));
    expect(frames.messages[1].command.actionText).toBe(
      "I will choose your saved Visa.",
    );
    frames.send({
      type: "result",
      id: frames.messages[1].id,
      ok: true,
      result: { dispatched: true },
    });
    await worded;
    const unbound = target.execute({
      subaction: "click",
      id: "1",
      selector: "00000000-0000-0000-0000-000000000000:0:0",
      actionText: "Unbound text.",
    } as never);
    for (const actionText of ["", "x".repeat(201), "line\nbreak"])
      await expect(
        target.execute(
          {
            subaction: "click",
            id: "1",
            selector: "00000000-0000-0000-0000-000000000000:0:0",
          },
          { taskContext, taskExpiresAt, actionText },
        ),
      ).rejects.toMatchObject({ kind: "POLICY_BLOCKED" });
    await vi.waitFor(() => expect(frames.messages).toHaveLength(3));
    expect(frames.messages[2].command.actionText).toBeUndefined();
    frames.send({
      type: "result",
      id: frames.messages[2].id,
      ok: true,
      result: { dispatched: true },
    });
    await unbound;
    // A reviewed target comes only from trusted options, and only a peer
    // that enforces it may receive one.
    await expect(
      target.execute(
        {
          subaction: "click",
          id: "1",
          selector: "00000000-0000-0000-0000-000000000000:0:0",
        },
        { taskContext, taskExpiresAt, expectedSelector: "#method" },
      ),
    ).rejects.toMatchObject({ kind: "UNSUPPORTED" });
    const raw = target.execute(
      {
        subaction: "click",
        id: "1",
        selector: "00000000-0000-0000-0000-000000000000:0:0",
        expectedSelector: "#page-chosen",
      } as never,
      { taskContext, taskExpiresAt },
    );
    await vi.waitFor(() => expect(frames.messages).toHaveLength(4));
    expect(frames.messages[3].command.expectedSelector).toBeUndefined();
    frames.send({
      type: "result",
      id: frames.messages[3].id,
      ok: true,
      result: { dispatched: true },
    });
    await raw;
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects protected fill before transport without explicit peer support", async () => {
  const target = new NativeSocketBrowserTarget(() => {});
  await expect(
    target.execute(
      { subaction: "fill", id: "1", selector: "target", text: "123456" },
      {
        protectedValueKind: "verification-code",
        taskContext: {
          actorId: "a",
          accountId: "b",
          agentId: "c",
          taskId: "d",
          epoch: 0,
        },
      },
    ),
  ).rejects.toMatchObject({ kind: "UNSUPPORTED" });
});

it("binds Android sockets to validated host application identity", async () => {
  expect(androidNativeBrowserSocketPath()).toBe(
    "\0ai.elizaos.app.browser.native",
  );
  expect(androidNativeBrowserSocketPath("org.example.consumer")).toBe(
    "\0org.example.consumer.browser.native",
  );
  for (const invalid of [
    "",
    "single",
    "org.example/other",
    "org.example ",
    "org.example\0other",
    `org.${"x".repeat(110)}`,
  ]) {
    expect(() => androidNativeBrowserSocketPath(invalid)).toThrow(
      "Invalid native browser Android application ID",
    );
    const target = new NativeSocketBrowserTarget(() => {});
    await expect(
      target.start({
        ELIZA_PLATFORM: "android",
        ELIZA_BROWSER_ANDROID_APPLICATION: invalid,
      }),
    ).rejects.toThrow("Invalid native browser Android application ID");
    await target.stop();
  }
});

it("waits for only the expected registration without sending commands and rejects unavailable waits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-profile-wait-"));
  const target = new NativeSocketBrowserTarget(() => {});
  let socket: Socket | undefined;
  try {
    await target.start({
      ELIZA_BROWSER_NATIVE_SOCKET: join(directory, "browser.sock"),
    });
    await expect(
      target.waitForProfile("wanted", { timeoutMs: 20 }),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    const controller = new AbortController();
    const aborted = expect(
      target.waitForProfile("wanted", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await aborted;
    const registered = target.waitForProfile("wanted");
    socket = createConnection(join(directory, "browser.sock"));
    const frames = socketFrames(socket);
    frames.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "wanted",
      capabilities: ["list"],
      nonce: "wait-nonce",
    });
    await registered;
    await vi.waitFor(() => expect(frames.messages).toHaveLength(1));
    expect(frames.messages[0]?.type).toBe("hello-ack");
    await expect(target.waitForProfile("different")).rejects.toMatchObject({
      kind: "UNAVAILABLE",
    });
    await expect(
      target.waitForProfile("wanted", { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    for (const timeoutMs of [0, -1, 1.5, 30001, Number.NaN])
      await expect(
        target.waitForProfile("wanted", { timeoutMs }),
      ).rejects.toThrow("Invalid native profile");
    await expect(target.waitForProfile("")).rejects.toThrow(
      "Invalid native profile",
    );
    socket.destroy();
    await vi.waitFor(() => expect(target.getProfileId()).toBeNull());
    const stopped = expect(
      target.waitForProfile("wanted"),
    ).rejects.toMatchObject({ kind: "UNAVAILABLE" });
    await target.stop();
    await stopped;
    expect(frames.messages).toHaveLength(1);
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("relays one value-free answer for the current offer and drops stale answers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-guide-answer-"));
  const socketPath = join(directory, "browser.sock");
  const diagnostics: Error[] = [];
  const target = new NativeSocketBrowserTarget((error) =>
    diagnostics.push(error),
  );
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const frames = socketFrames(socket);
    frames.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "answer-profile",
      capabilities: ["task-bind", "task-guide", "task-guide-label"],
    });
    await vi.waitFor(async () => expect(await target.available()).toBe(true));
    const answers: unknown[] = [];
    target.onTaskGuideAnswer((answer) => answers.push(answer));
    const base = {
      tabId: "1",
      taskContext: {
        actorId: "actor",
        accountId: "account",
        agentId: "agent",
        taskId: "task",
        epoch: 1,
      },
      kind: "show" as const,
      stepId: "email",
      selector: "00000000-0000-0000-0000-000000000000:0:0",
      text: "Which email?",
      tone: "offer" as const,
      answers: [
        { id: "card-0", kind: "card" as const, text: "a@example.test" },
        { id: "card-1", kind: "card" as const, text: "b@example.test" },
        { id: "type", kind: "secondary" as const, text: "I'll type it" },
      ],
      expiresAt: Date.now() + 60000,
    };
    const shown = target.guideTask({ ...base, revision: 1 });
    await vi.waitFor(() => expect(frames.messages).toHaveLength(1));
    const offerId = frames.messages[0].id;
    frames.send({
      type: "result",
      id: offerId,
      ok: true,
      result: { accepted: true },
    });
    await shown;
    const answer = {
      type: "task-guide-answer",
      id: offerId,
      tabId: "1",
      stepId: "email",
      revision: 1,
      answerId: "card-1",
    };
    frames.send({ ...answer, answerId: "card-9" });
    frames.send(answer);
    frames.send(answer);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    expect(answers[0]).toEqual({
      tabId: "1",
      stepId: "email",
      revision: 1,
      answerId: "card-1",
    });
    // A newer guide for the tab replaces the offer before an in-flight answer lands.
    const second = target.guideTask({ ...base, revision: 2 });
    await vi.waitFor(() => expect(frames.messages).toHaveLength(2));
    const secondId = frames.messages[1].id;
    frames.send({
      type: "result",
      id: secondId,
      ok: true,
      result: { accepted: true },
    });
    await second;
    const paused = target.guideTask({
      tabId: "1",
      taskContext: base.taskContext,
      revision: 3,
      kind: "pause",
    });
    await vi.waitFor(() => expect(frames.messages).toHaveLength(3));
    frames.send({
      type: "result",
      id: frames.messages[2].id,
      ok: true,
      result: { visible: false, paused: true },
    });
    await paused;
    frames.send({ ...answer, id: secondId, revision: 2, answerId: "type" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answers).toHaveLength(1);
    expect(await target.available()).toBe(true);
    // An answer already in flight must not cross a binding replacement.
    const third = target.guideTask({ ...base, revision: 4 });
    await vi.waitFor(() => expect(frames.messages).toHaveLength(4));
    const thirdId = frames.messages[3].id;
    frames.send({
      type: "result",
      id: thirdId,
      ok: true,
      result: { accepted: true },
    });
    await third;
    const rebound = target.bindTask({
      ...base.taskContext,
      epoch: 2,
      bindingRevision: 2,
      tabId: "1",
      origin: "https://example.test",
      expiresAt: Date.now() + 60000,
      targets: [],
      revoked: false,
    });
    await vi.waitFor(() => expect(frames.messages).toHaveLength(5));
    frames.send({ ...answer, id: thirdId, revision: 4 });
    frames.send({
      type: "result",
      id: frames.messages[4].id,
      ok: true,
      result: { bound: true },
    });
    await rebound;
    expect(answers).toHaveLength(1);
    // A malformed or value-carrying answer is a protocol violation.
    frames.send({ ...answer, value: "b@example.test" });
    await vi.waitFor(async () => expect(await target.available()).toBe(false));
    expect(JSON.stringify(answers)).not.toContain("example.test");
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("requires the guide-label capability for labels, offers, pause and a configured name", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-guide-label-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {});
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const frames = socketFrames(socket);
    frames.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "older-profile",
      capabilities: ["task-bind", "task-guide"],
    });
    await vi.waitFor(async () => expect(await target.available()).toBe(true));
    const taskContext = {
      actorId: "actor",
      accountId: "account",
      agentId: "agent",
      taskId: "task",
      epoch: 1,
    };
    for (const guidance of [
      { tabId: "1", taskContext, revision: 1, kind: "pause" as const },
      {
        tabId: "1",
        taskContext,
        revision: 1,
        kind: "show" as const,
        stepId: "s",
        selector: "00000000-0000-0000-0000-000000000000:0:0",
        text: "Done.",
        tone: "success" as const,
        expiresAt: Date.now() + 60000,
      },
    ])
      await expect(target.guideTask(guidance)).rejects.toMatchObject({
        kind: "UNSUPPORTED",
      });
    await expect(
      target.bindTask({
        ...taskContext,
        tabId: "1",
        bindingRevision: 1,
        origin: "https://example.test",
        expiresAt: Date.now() + 60000,
        revoked: false,
        targets: [],
        assistantName: "Grace",
      }),
    ).rejects.toMatchObject({ kind: "UNSUPPORTED" });
    expect(frames.messages).toHaveLength(0);
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("reduces the one active HTTPS page to its origin and a complete, redacted title", () => {
  const tab = {
    id: "7",
    url: "https://pay.example.test/account/123?token=secret#review",
    title: "  Pay\u0000 your\u200b bill\n now ",
    active: true,
    windowId: 1,
  };
  expect(
    currentPageFromTabs(
      [tab, { ...tab, id: "8", active: false, url: "https://other.test/" }],
      1,
    ),
  ).toEqual({
    tabId: "7",
    origin: "https://pay.example.test",
    title: "Pay your bill now",
  });
  // Preserve the complete title while redacting obvious personal data.
  const long = currentPageFromTabs([{ ...tab, title: "x".repeat(400) }], 1);
  expect(long?.title).toBe("x".repeat(400));
  expect(currentPageTitle(`${"a".repeat(119)}\u{1f600}`)).toBe(
    `${"a".repeat(119)}\u{1f600}`,
  );
  expect(currentPageTitle("a".repeat(120))).toHaveLength(120);
  expect(
    currentPageTitle(
      "Inbox (3) - margaret.smith@example.com - Mail · Account 1234 5678 9012",
    ),
  ).toBe("Inbox (3) - [email] - Mail · Account [number]");
  expect(currentPageTitle("Call 555-123-4567 · Bill for March 2026")).toBe(
    "Call [number] · Bill for March 2026",
  );
  expect(currentPageFromTabs([{ ...tab, title: undefined }], 1)?.title).toBe(
    "",
  );
  // Unknown or ambiguous pages are not guessed.
  expect(currentPageFromTabs([], 1)).toBeNull();
  expect(currentPageFromTabs([{ ...tab, active: false }], 1)).toBeNull();
  expect(
    currentPageFromTabs([tab, { ...tab, id: "9", windowId: 2 }], 2),
  ).toBeNull();
  expect(
    currentPageFromTabs(
      [tab, { ...tab, id: "9", active: false, windowId: 2 }],
      2,
    ),
  ).toBeNull();
  // A second window that holds only a new-tab or settings page is not in the
  // web-tab inventory, but it is counted, so the page she sees is unknown.
  expect(currentPageFromTabs([tab], 2)).toBeNull();
  // An extension that does not count windows cannot rule that out.
  expect(currentPageFromTabs([tab], undefined)).toBeNull();
  expect(currentPageFromTabs([tab], "1")).toBeNull();
  expect(
    currentPageFromTabs([{ ...tab, url: "http://pay.example.test/" }], 1),
  ).toBeNull();
  expect(
    currentPageFromTabs(
      [{ ...tab, url: "https://user:pw@pay.example.test/" }],
      1,
    ),
  ).toBeNull();
  expect(currentPageFromTabs([{ ...tab, url: "not a url" }], 1)).toBeNull();
  expect(currentPageFromTabs([{ ...tab, id: "x" }], 1)).toBeNull();
});

it("reads the current page through a list request and sends nothing else", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-current-page-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {});
  let socket: Socket | undefined;
  try {
    await expect(target.currentPage()).rejects.toMatchObject({
      kind: "UNSUPPORTED",
    });
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const peer = socketFrames(socket);
    peer.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "page-profile",
      capabilities: ["list"],
    });
    await vi.waitFor(async () => expect(await target.available()).toBe(true));
    const page = target.currentPage();
    await vi.waitFor(() => expect(peer.messages).toHaveLength(1));
    expect(peer.messages[0]).toMatchObject({
      type: "command",
      command: { subaction: "list" },
    });
    peer.send({
      type: "result",
      id: peer.messages[0].id,
      ok: true,
      result: {
        tabs: [
          {
            id: "3",
            url: "https://bills.example.test/pay?amount=12",
            title: "Pay a bill",
            active: true,
            windowId: 4,
          },
        ],
        windowCount: 1,
      },
    });
    await expect(page).resolves.toEqual({
      tabId: "3",
      origin: "https://bills.example.test",
      title: "Pay a bill",
    });
    // An older extension that does not count windows: the page is unknown.
    const uncounted = target.currentPage();
    await vi.waitFor(() => expect(peer.messages).toHaveLength(2));
    peer.send({
      type: "result",
      id: peer.messages[1].id,
      ok: true,
      result: {
        tabs: [
          {
            id: "3",
            url: "https://bills.example.test/pay",
            title: "Pay a bill",
            active: true,
            windowId: 4,
          },
        ],
      },
    });
    await expect(uncounted).resolves.toBeNull();
    const invalid = target.currentPage();
    await vi.waitFor(() => expect(peer.messages).toHaveLength(3));
    peer.send({
      type: "result",
      id: peer.messages[2].id,
      ok: true,
      result: { tabs: "none" },
    });
    await expect(invalid).rejects.toThrow(/tab inventory/);
    expect(peer.messages).toHaveLength(3);
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("refuses the current page when the peer cannot list tabs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "native-current-page-old-"));
  const socketPath = join(directory, "browser.sock");
  const target = new NativeSocketBrowserTarget(() => {});
  let socket: Socket | undefined;
  try {
    await target.start({ ELIZA_BROWSER_NATIVE_SOCKET: socketPath });
    socket = createConnection(socketPath);
    const peer = socketFrames(socket);
    peer.send({
      type: "hello",
      protocol: 2,
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      profileId: "page-profile",
      capabilities: ["snapshot"],
    });
    await vi.waitFor(async () => expect(await target.available()).toBe(true));
    await expect(target.currentPage()).rejects.toMatchObject({
      kind: "UNSUPPORTED",
    });
    expect(peer.messages).toHaveLength(0);
  } finally {
    socket?.destroy();
    await target.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

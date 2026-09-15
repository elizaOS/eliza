/**
 * Exercises the real WebSocket hello boundary around paid voice admission.
 * The deterministic socket proves denial performs zero session/provider work,
 * admission precedes start, and failed starts retain asynchronous rollback.
 */

import { expect, mock, test } from "bun:test";
import { attachVoiceWsHandler, type ServerWebSocketLike } from "./ws-handler";

class TestSocket implements ServerWebSocketLike {
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  private readonly listeners = new Map<string, Array<(event: { data: unknown }) => void>>();

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {}
  addEventListener(
    type: "message" | "close" | "error",
    listener: (event: { data: unknown }) => void,
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  message(data: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data });
  }
}

const verified = {
  claims: {
    sessionId: "session-1",
    organizationId: "org-1",
    userId: "user-1",
    agentId: "agent-1",
    conversationId: "conversation-1",
  },
  jti: "jti-1",
  expSeconds: Math.floor(Date.now() / 1_000) + 60,
};

async function flushHello(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const hello = JSON.stringify({
  t: "hello",
  protocol: 1,
  token: "token",
  uplinkCodec: "pcm16",
  downlinkCodec: "pcm16",
  sampleRate: 16_000,
});

test("voice provider admission denial performs zero provider dispatch", async () => {
  const socket = new TestSocket();
  const buildSession = mock(() => {
    throw new Error("provider must not be constructed");
  });
  attachVoiceWsHandler(socket, {
    requestedSessionId: "session-1",
    verifyToken: mock(async () => verified),
    claimToken: mock(async () => true),
    admitSession: () => true,
    admitProviderSession: async () => {
      throw Object.assign(new Error("quota denied"), {
        code: "quota_exhausted",
      });
    },
    buildSession,
  });

  socket.message(hello);
  await flushHello();

  expect(buildSession).not.toHaveBeenCalled();
  expect(socket.sent.map(String).join("\n")).toContain("quota_exhausted");
});

test("voice admission is recorded before start and failed start rolls back asynchronously", async () => {
  const socket = new TestSocket();
  const order: string[] = [];
  const release = mock(async () => {
    order.push("release");
  });
  const retained: Promise<unknown>[] = [];
  attachVoiceWsHandler(socket, {
    requestedSessionId: "session-1",
    verifyToken: async () => {
      order.push("verify");
      return verified;
    },
    claimToken: async () => {
      order.push("claim");
      return true;
    },
    admitSession: () => true,
    admitProviderSession: async () => {
      order.push("admit");
      return { admittedMinutes: 5 / 60, release };
    },
    buildSession: ({ initialUsageAdmissionMinutes }) => {
      order.push(`build:${initialUsageAdmissionMinutes}`);
      return {
        start() {
          order.push("start");
          throw new Error("provider open failed");
        },
        pushUplinkAudio() {},
        bargeIn() {},
        bye() {},
        sever() {},
      };
    },
    defer: (promise) => retained.push(promise),
  });

  socket.message(hello);
  await flushHello();
  await Promise.all(retained);

  expect(order).toEqual(["verify", "claim", "admit", `build:${5 / 60}`, "start", "release"]);
  expect(release).toHaveBeenCalledTimes(1);
});

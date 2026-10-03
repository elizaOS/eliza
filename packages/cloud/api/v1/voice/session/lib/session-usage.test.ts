import { expect, test } from "bun:test";
import { InMemoryVoiceUsageStore } from "@/lib/services/voice-usage-meter";
import type { ServerControlFrame } from "@/lib/voice-session/protocol";
import { VoiceSession } from "./session";

// Exercise the real provider adapters with local WebSocket protocol events.
class ProviderSocket {
  readyState = 0;
  binaryType: BinaryType = "arraybuffer";
  private readonly listeners = new Map<string, Set<(event: never) => void>>();
  constructor(private readonly phrase: (text: string) => void) {
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open", new Event("open"));
    });
  }
  addEventListener(type: string, listener: (event: never) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: string, listener: (event: never) => void) {
    this.listeners.get(type)?.delete(listener);
  }
  private emit(type: string, event: Event) {
    for (const listener of this.listeners.get(type) ?? [])
      listener(event as never);
  }
  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (typeof data !== "string") return;
    const message = JSON.parse(data);
    if (typeof message.transcript !== "string") return;
    this.phrase(message.transcript);
    if (message.continue === false) {
      queueMicrotask(() =>
        this.emit(
          "message",
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "done",
              context_id: message.context_id,
            }),
          }),
        ),
      );
    }
  }
  close() {
    this.readyState = 3;
  }
}

for (const { name, ack, reply, interrupted } of [
  {
    name: "completed with ACK",
    ack: "Checking.",
    reply: "The note is saved.",
    interrupted: false,
  },
  {
    name: "interrupted after ACK",
    ack: "Checking.",
    reply: "The note is saved.",
    interrupted: true,
  },
  {
    name: "completed without ACK",
    ack: "",
    reply: "Hello.",
    interrupted: false,
  },
  {
    name: "streamed reply with ACK",
    ack: "Checking.",
    reply: "The green notebook is packed. ".repeat(40).trim(),
    interrupted: false,
  },
]) {
  test(`counts submitted speech once: ${name}`, async () => {
    const sent: string[] = [];
    let ackSent!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      ackSent = resolve;
    });
    let usageReceived!: (
      value: Extract<ServerControlFrame, { t: "usage" }>,
    ) => void;
    const usage = new Promise<Extract<ServerControlFrame, { t: "usage" }>>(
      (resolve) => {
        usageReceived = resolve;
      },
    );
    const encode = (value: object) =>
      new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
    const session = new VoiceSession({
      sessionId: crypto.randomUUID(),
      jti: crypto.randomUUID(),
      organizationId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      agentId: crypto.randomUUID(),
      conversationId: crypto.randomUUID(),
      tokenExpSeconds: Math.floor(Date.now() / 1000) + 60,
      cartesiaApiKey: "local-test-only",
      cartesiaVoiceId: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
      cartesiaInkWebSocketFactory: () => new ProviderSocket(() => {}),
      cartesiaWebSocketFactory: () =>
        new ProviderSocket((text) => {
          sent.push(text);
          if (text === ack) ackSent();
        }),
      elizaEndpoint: "http://local.test",
      elizaAuthorization: "Bearer test",
      elizaModel: "test",
      openingPrompt: "Read my note",
      usageStore: new InMemoryVoiceUsageStore(),
      usageLimits: { organizationDailyMinutes: 10, userDailyMinutes: 10 },
      fetchImpl: Object.assign(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                if (ack)
                  controller.enqueue(
                    encode({ type: "status", kind: "thinking", label: ack }),
                  );
                if (!interrupted) {
                  controller.enqueue(encode({ type: "done", text: reply }));
                  controller.close();
                }
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          ),
        { preconnect() {} },
      ),
      downlink: {
        sendControl(frame) {
          if (frame.t === "usage") usageReceived(frame);
        },
        sendAudio() {},
        close() {},
      },
    });
    try {
      session.start();
      if (ack) await acknowledged;
      if (interrupted) session.bargeIn();
      const receipt = await usage;
      if (interrupted) expect(sent).toEqual([ack]);
      else
        expect(sent.join(" ").replace(/\s+/g, " ")).toBe(
          [ack, reply].filter(Boolean).join(" "),
        );
      expect(receipt.ttsChars).toBe(sent.join("").length);
    } finally {
      session.bye();
    }
  }, 5000);
}

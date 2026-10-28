import { expect, test } from "vitest";
import { cartesiaEvents } from "../../test/fixtures/cartesia-events";
import { synthesizeDirectReadAloud } from "./self-hosted-read-aloud";

function fixture(mode = "ok") {
  const sent: Array<Record<string, unknown>> = [],
    closed: unknown[][] = [];
  let created = 0;
  const events = cartesiaEvents(),
    emit = events.emit;
  const socket = {
    readyState: 0,
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    send(data: string) {
      const value = JSON.parse(data);
      sent.push(value);
      if (value.cancel || mode === "wait") return;
      queueMicrotask(() => {
        if (mode === "error") {
          emit("message", {
            data: JSON.stringify({
              type: "error",
              context_id: value.context_id,
              error: "private-vendor-error",
            }),
          });
          return;
        }
        if (mode !== "empty")
          emit("message", {
            data: JSON.stringify({
              type: "chunk",
              context_id: value.context_id,
              data: Buffer.from([0, 128, 255, 127]).toString("base64"),
            }),
          });
        emit("message", {
          data: JSON.stringify({
            type: "done",
            context_id: value.context_id,
            done: true,
          }),
        });
      });
    },
    close(...args: unknown[]) {
      socket.readyState = 3;
      closed.push(args);
      emit("close", { code: 1000 });
    },
  };
  return {
    sent,
    closed,
    socket,
    created: () => created,
    config: {
      apiKey: "synthetic",
      voiceId: "11111111-1111-4111-8111-111111111111",
      websocketFactory: () => {
        created++;
        if (mode !== "held")
          queueMicrotask(() => {
            socket.readyState = 1;
            emit("open", undefined);
          });
        return socket;
      },
    },
  };
}
test("real Sonic adapter reads exact text once and canonical WAV preserves raw extrema", async () => {
  const f = fixture();
  let checks = 0;
  const audio = await synthesizeDirectReadAloud({
    text: "Owned message",
    signal: new AbortController().signal,
    beforeDispatch: async () => {
      checks++;
    },
    config: f.config,
  });
  expect(checks).toBe(3);
  expect(f.created()).toBe(1);
  expect(f.sent.filter((x) => x.transcript).map((x) => x.transcript)).toEqual([
    "Owned message",
  ]);
  expect(Buffer.from(audio).toString("ascii", 0, 4)).toBe("RIFF");
  expect(new DataView(audio.buffer).getUint32(24, true)).toBe(16000);
  expect([...audio.slice(44)]).toEqual([0, 128, 255, 127]);
  expect(f.closed.length).toBe(1);
});
test("cancel before dispatch opens no provider transport", async () => {
  const f = fixture(),
    c = new AbortController();
  c.abort();
  await expect(
    synthesizeDirectReadAloud({
      text: "Owned",
      signal: c.signal,
      beforeDispatch: async () => {},
      config: f.config,
    }),
  ).rejects.toThrow();
  expect(f.created()).toBe(0);
});
test("changed owner after open sends no text and closes its owned transport", async () => {
  const f = fixture();
  let checks = 0;
  await expect(
    synthesizeDirectReadAloud({
      text: "Owned",
      signal: new AbortController().signal,
      beforeDispatch: async () => {
        if (++checks === 2) throw Error("owner changed");
      },
      config: f.config,
    }),
  ).rejects.toThrow("owner changed");
  expect(f.sent.filter((x) => x.transcript).length).toBe(0);
  expect(f.closed.length).toBe(1);
});
test("Stop during provider upgrade retires pending read-aloud without text or leak", async () => {
  const f = fixture("held"),
    c = new AbortController(),
    p = synthesizeDirectReadAloud({
      text: "Owned",
      signal: c.signal,
      beforeDispatch: async () => {},
      config: f.config,
    });
  void p.catch(() => {});
  for (let i = 0; i < 8; i++) await Promise.resolve();
  c.abort();
  await expect(p).rejects.toThrow();
  expect(f.sent.filter((x) => x.transcript).length).toBe(0);
  expect(f.closed.length).toBe(1);
});
test("provider error and empty audio never produce playback bytes or leak vendor detail", async () => {
  for (const mode of ["error", "empty"]) {
    const f = fixture(mode);
    await expect(
      synthesizeDirectReadAloud({
        text: "Owned",
        signal: new AbortController().signal,
        beforeDispatch: async () => {},
        config: f.config,
      }),
    ).rejects.toThrow(
      mode === "error"
        ? "Read-aloud provider failed"
        : "Empty read-aloud audio",
    );
    expect(f.closed.length).toBe(1);
  }
});

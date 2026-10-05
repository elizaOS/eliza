import assert from "node:assert/strict";
import test from "node:test";
import { DraftTranscriptGuard } from "../../src/voice/draft-transcript-guard.ts";
import { RecordedTranscriptionController } from "../../src/voice/recorded-transcription-controller.ts";

const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fixture(overrides = {}) {
  const tracks = [
      {
        stops: 0,
        stop() {
          this.stops++;
        },
      },
    ],
    stream = { getTracks: () => tracks },
    recorders = [],
    states = [],
    transcripts = [],
    requests = [];
  let closeLive = 0,
    closeEndpoint = 0,
    receive,
    previewActive,
    finish;
  const c = new RecordedTranscriptionController({
    authorize: async () => {},
    encode: async (b) => String(b.size),
    transcribe: async (data, mime) => {
      requests.push({ data, mime });
      return { text: "Final words" };
    },
    preview: async (_, r, a) => {
      receive = r;
      previewActive = a;
      return () => closeLive++;
    },
    changed: (s) => states.push(s),
    maximumBytes: 10,
    maximumMs: 60000,
    timesliceMs: 1000,
    constraints: { audio: true },
    mimeTypes: ["audio/webm"],
    environment: {
      acquire: async () => stream,
      recorder: () => {
        const r = {
          state: "inactive",
          mimeType: "audio/webm",
          start() {
            this.state = "recording";
          },
          stop() {
            this.state = "inactive";
            this.onstop?.();
          },
          data(size) {
            this.ondataavailable?.({
              data: new Blob(["a".repeat(size)], { type: this.mimeType }),
            });
          },
        };
        recorders.push(r);
        return r;
      },
    },
    ...overrides,
  });
  return {
    c,
    tracks,
    stream,
    recorders,
    states,
    transcripts,
    requests,
    start: () =>
      c.start(
        (text, final) => transcripts.push({ text, final }),
        (_, f) => {
          finish = f;
          return () => closeEndpoint++;
        },
      ),
    get receive() {
      return receive;
    },
    get previewActive() {
      return previewActive;
    },
    get finish() {
      return finish;
    },
    get closeLive() {
      return closeLive;
    },
    get closeEndpoint() {
      return closeEndpoint;
    },
  };
}
test("final recording releases every capture resource before transcription and never sends a message", async () => {
  const f = fixture();
  await f.start();
  f.recorders[0].data(4);
  await f.receive(new Blob(["ab"], { type: "audio/wav" }));
  assert.deepEqual(f.transcripts, [{ text: "Final words", final: false }]);
  f.finish();
  await tick();
  assert.deepEqual(f.requests, [
    { data: "2", mime: "audio/wav" },
    { data: "4", mime: "audio/webm" },
  ]);
  assert.deepEqual(f.transcripts.at(-1), { text: "Final words", final: true });
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(f.closeLive, 1);
  assert.equal(f.closeEndpoint, 1);
  assert.equal(f.c.pending, false);
  assert.equal(f.previewActive(), false);
});
test("cancelled acquisition closes its late stream without touching a replacement recording", async () => {
  const d = deferred(),
    f = fixture({
      environment: {
        acquire: () => d.promise,
        recorder: () => {
          throw Error("must not construct");
        },
      },
    });
  const old = f.start();
  await tick();
  f.c.cancel();
  d.resolve(f.stream);
  await old;
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(f.c.pending, false);
  assert.equal(f.transcripts.length, 0);
});
test("single-flight and cancelled final encoding never issue a transcription request", async () => {
  const d = deferred(),
    f = fixture({ encode: () => d.promise });
  await f.start();
  await f.start();
  assert.equal(f.recorders.length, 1);
  f.recorders[0].data(3);
  f.c.finish();
  f.c.cancel();
  d.resolve("encoded");
  await tick();
  assert.equal(f.requests.length, 0);
  assert.equal(f.transcripts.length, 0);
});
test("late final responses cannot publish or clear a new recording", async () => {
  const d = deferred(),
    f = fixture({ transcribe: () => d.promise });
  await f.start();
  f.recorders[0].data(3);
  f.c.finish();
  await tick();
  f.c.cancel();
  await f.start();
  d.resolve({ text: "stale" });
  await tick();
  assert.equal(f.c.recording, true);
  assert.equal(f.c.pending, true);
  assert.equal(f.transcripts.length, 0);
  f.c.cancel();
});
test("late preview setup is disposed and previews cannot race final text", async () => {
  const setup = deferred(),
    reply = deferred();
  let receive,
    active,
    closed = 0;
  const f = fixture({
    preview: async (_, r, a) => {
      receive = r;
      active = a;
      return setup.promise;
    },
    transcribe: () => reply.promise,
  });
  const start = f.start();
  await tick();
  const preview = receive(new Blob(["ab"]));
  await tick();
  f.recorders[0].data(2);
  f.c.finish();
  setup.resolve(() => closed++);
  await start;
  assert.equal(closed, 1);
  assert.equal(active(), false);
  reply.resolve({ text: "words" });
  await preview;
  await tick();
  assert.deepEqual(f.transcripts, [{ text: "words", final: true }]);
});
test("byte limit and empty recordings fail without uploading; recorder errors release resources", async () => {
  for (const [bytes, code] of [
    [11, "too-large"],
    [0, "empty-audio"],
  ]) {
    const f = fixture();
    await f.start();
    if (bytes) f.recorders[0].data(bytes);
    else f.c.finish();
    await tick();
    assert.equal(f.states.at(-1).error.code, code);
    assert.equal(f.requests.length, 0);
    assert.equal(f.tracks[0].stops, 1);
  }
  const f = fixture();
  await f.start();
  f.recorders[0].onerror();
  assert.equal(f.states.at(-1).error.code, "recording");
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(f.closeLive, 1);
});
test("duration limit finalizes and cancel clears its timer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ maximumMs: 100 });
  await f.start();
  f.recorders[0].data(2);
  t.mock.timers.tick(100);
  await tick();
  assert.equal(f.transcripts.at(-1).final, true);
  await f.start();
  f.c.cancel();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(f.transcripts.length, 1);
});
test("setup failures release streams and do not leave a recorder running", async () => {
  const f = fixture({
    preview: async () => {
      throw Error("setup failed");
    },
  });
  await f.start();
  assert.equal(f.c.pending, false);
  assert.equal(f.tracks[0].stops, 1);
  assert.equal(f.recorders[0].state, "inactive");
  assert.equal(f.closeEndpoint, 1);
  assert.equal(f.states.at(-1).error.message, "setup failed");
});
test("draft previews do not count as edits, while edited-and-reverted drafts retain final conflicts", () => {
  const guard = new DraftTranscriptGuard();
  guard.observe("Typed");
  const receive = guard.begin((a, b) => `${a}\n${b}`);
  assert.deepEqual(receive("Preview", false), {
    kind: "applied",
    value: "Typed\nPreview",
  });
  guard.observe("Typed\nPreview");
  assert.equal(receive("Final", true).kind, "applied");
  const conflict = guard.begin((_, b) => b);
  guard.observe("Edit");
  guard.observe("Typed\nFinal");
  assert.equal(conflict("Preview", false).kind, "ignored");
  assert.deepEqual(conflict("Final recording", true), {
    kind: "conflict",
    value: "Final recording",
  });
  guard.invalidate();
  assert.equal(conflict("Late", true).kind, "ignored");
  const first = guard.begin((_, b) => b);
  guard.begin((_, b) => b);
  assert.equal(first("Old", true).kind, "ignored");
});

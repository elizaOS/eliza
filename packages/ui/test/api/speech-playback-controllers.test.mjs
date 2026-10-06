import assert from "node:assert/strict";
import test from "node:test";
import { DeviceSpeechController } from "../../src/voice/device-speech-controller.ts";
import {
  SegmentedSpeechPlayback,
  SpeechPlaybackError,
} from "../../src/voice/segmented-speech-playback.ts";

const tick = () => new Promise((r) => setImmediate(r));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function device() {
  const win = new EventTarget(),
    doc = new EventTarget(),
    utterances = [],
    states = [];
  let cancels = 0;
  const environment = {
    window: win,
    document: doc,
    utterance: (text) => ({ text }),
    synthesis: { speak: (u) => utterances.push(u), cancel: () => cancels++ },
  };
  const controller = new DeviceSpeechController(
    (s) => states.push(s),
    environment,
  );
  return {
    controller,
    environment,
    win,
    doc,
    utterances,
    states,
    get cancels() {
      return cancels;
    },
  };
}
test("device speech fences captured stale callbacks and preserves explicit language/rate", () => {
  const f = device();
  f.controller.speak("First", "fr-FR", 0.7);
  const late = f.utterances[0].onerror;
  assert.equal(f.utterances[0].rate, 0.7);
  assert.equal(f.utterances[0].lang, "fr-FR");
  f.controller.speak("Second", "en-US", 1);
  late();
  assert.deepEqual(f.states.at(-1), { speaking: true, error: null });
  f.controller.stop();
  f.utterances[1].onerror?.();
  assert.deepEqual(f.states.at(-1), { speaking: false, error: null });
  f.controller.dispose();
});
test("device speech stops on background/pagehide and removes listeners without publishing on disposal", () => {
  const f = device();
  f.controller.speak("Hello", "en", 1);
  f.doc.hidden = true;
  f.doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(f.states.at(-1).speaking, false);
  f.controller.speak("Again", "en", 1);
  f.win.dispatchEvent(new Event("pagehide"));
  assert.equal(f.states.at(-1).speaking, false);
  const count = f.states.length;
  f.controller.dispose();
  const cancels = f.cancels;
  f.doc.dispatchEvent(new Event("visibilitychange"));
  f.win.dispatchEvent(new Event("pagehide"));
  f.controller.speak("Late", "en", 1);
  assert.equal(f.states.length, count);
  assert.equal(f.cancels, cancels);
});
test("device speech reports unavailable and construction/speak failures without leaking active state", () => {
  const states = [];
  new DeviceSpeechController((s) => states.push(s), null).speak("x", "en", 1);
  assert.equal(states.at(-1).error, "unavailable");
  for (const mode of ["utterance", "speak"]) {
    const f = device();
    if (mode === "utterance")
      f.environment.utterance = () => {
        throw Error("no");
      };
    else
      f.environment.synthesis.speak = () => {
        throw Error("no");
      };
    f.controller.speak("x", "en", 1);
    assert.deepEqual(f.states.at(-1), { speaking: false, error: "playback" });
    f.controller.dispose();
  }
});
function playback(
  synthesize = async () => ({ audioBase64: "YQ==", mimeType: "audio/wav" }),
) {
  const players = [],
    created = [],
    revoked = [],
    states = [],
    requests = [];
  const controller = new SegmentedSpeechPlayback({
    synthesize: async (text) => {
      requests.push(text);
      return synthesize(text);
    },
    changed: (s) => states.push(s),
    environment: {
      createUrl: (blob) => {
        created.push(blob);
        return `blob:${created.length}`;
      },
      revokeUrl: (url) => revoked.push(url),
      audio: (url) => {
        const p = {
          url,
          paused: 0,
          play: async () => {},
          pause() {
            this.paused++;
          },
        };
        players.push(p);
        return p;
      },
    },
  });
  return { controller, players, created, revoked, states, requests };
}
test("clips play sequentially with live pace, waiting captions, complete text and exact URL cleanup", async () => {
  const f = playback();
  f.controller.setRate(0.8);
  const run = f.controller.speak("First sentence. Second sentence.");
  await tick();
  assert.deepEqual(f.requests, ["First sentence."]);
  assert.equal(f.players[0].playbackRate, 0.8);
  assert.equal(f.states.at(-1).caption, "First sentence.");
  f.players[0].onwaiting();
  assert.equal(f.states.at(-1).caption, "");
  f.players[0].onplaying();
  f.controller.setRate(1.2);
  assert.equal(f.players[0].playbackRate, 1.2);
  f.players[0].onended();
  await tick();
  assert.deepEqual(f.requests, ["First sentence.", "Second sentence."]);
  assert.equal(f.players[1].playbackRate, 1.2);
  f.players[1].onended();
  await run;
  assert.deepEqual(f.revoked, ["blob:1", "blob:2"]);
  assert.equal(f.controller.pending, false);
  assert.deepEqual(f.states.at(-1), { phase: "idle", caption: "" });
});
test("stop while synthesis is pending drops old results and cannot settle a newer session", async () => {
  const old = deferred(),
    next = deferred();
  let count = 0;
  const f = playback(() => (++count === 1 ? old.promise : next.promise));
  const a = f.controller.speak("Old.");
  await f.controller.speak("Duplicate.");
  assert.equal(f.requests.length, 1);
  f.controller.stop();
  const b = f.controller.speak("New.");
  old.resolve({ audioBase64: "YQ==", mimeType: "audio/wav" });
  await a;
  assert.equal(f.controller.pending, true);
  assert.equal(f.players.length, 0);
  next.resolve({ audioBase64: "YQ==", mimeType: "audio/wav" });
  await tick();
  f.players[0].onended();
  await b;
  assert.equal(f.players.length, 1);
});
test("stop settles playback and late play resolution cannot restart or caption old audio", async () => {
  const play = deferred();
  const player = {
    play: () => play.promise,
    pause: () => {
      player.pauses++;
    },
    pauses: 0,
  };
  const states = [];
  const revoked = [];
  const c = new SegmentedSpeechPlayback({
    synthesize: async () => ({ audioBase64: "YQ==", mimeType: "audio/wav" }),
    changed: (s) => states.push(s),
    environment: {
      audio: () => player,
      createUrl: () => "blob:x",
      revokeUrl: (u) => revoked.push(u),
    },
  });
  const pending = c.speak("First. Second.");
  await tick();
  const playing = player.onplaying;
  c.stop();
  await pending;
  playing();
  play.resolve();
  await tick();
  assert.deepEqual(states.at(-1), { phase: "idle", caption: "" });
  assert.deepEqual(revoked, ["blob:x"]);
  assert.ok(player.pauses >= 2);
  assert.equal(c.pending, false);
});
test("invalid payload, play rejection and constructor failure release resources and pending state", async () => {
  for (const value of [
    null,
    {},
    { audioBase64: "!!!", mimeType: "audio/wav" },
    { audioBase64: "YQ==", mimeType: "text/html" },
  ]) {
    const f = playback(async () => value);
    await assert.rejects(
      f.controller.speak("Hello"),
      (e) => e instanceof SpeechPlaybackError && e.code === "invalid-audio",
    );
    assert.equal(f.controller.pending, false);
    assert.equal(f.created.length, 0);
  }
  for (const mode of ["construct", "play"]) {
    const revoked = [];
    const c = new SegmentedSpeechPlayback({
      synthesize: async () => ({ audioBase64: "YQ==", mimeType: "audio/wav" }),
      changed: () => {},
      environment: {
        createUrl: () => "blob:x",
        revokeUrl: (u) => revoked.push(u),
        audio: () => {
          if (mode === "construct") throw Error("construction");
          return { pause() {}, play: () => Promise.reject(Error("denied")) };
        },
      },
    });
    await assert.rejects(c.speak("Hello"));
    assert.deepEqual(revoked, ["blob:x"]);
    assert.equal(c.pending, false);
  }
});

test("settlement observer owns errors and suppresses cancelled operations", async () => {
  const d = deferred(),
    f = playback(() => d.promise),
    results = [];
  const pending = f.controller.speak("Old", (e) => results.push(e));
  f.controller.stop();
  d.reject(Error("old"));
  await pending;
  assert.deepEqual(results, []);
  const bad = playback(async () => null);
  await bad.controller.speak("Bad", (e) => results.push(e));
  assert.equal(results[0].code, "invalid-audio");
  const good = playback();
  const success = good.controller.speak("Good", (e) => results.push(e));
  await tick();
  good.players[0].onended();
  await success;
  assert.equal(results.at(-1), null);
  assert.equal(good.controller.pending, false);
});

function progressive(hook) {
  const streams = [],
    players = [],
    states = [];
  const controller = new SegmentedSpeechPlayback({
    segments: (text) => [text],
    changed: (state) => states.push(state),
    attach: (_player, text, callbacks) => {
      const load = deferred();
      const stream = { text, callbacks, load, disposed: 0 };
      streams.push(stream);
      hook?.(stream, controller);
      return {
        loaded: load.promise,
        dispose: () => {
          stream.disposed++;
        },
      };
    },
    environment: {
      createUrl: () => {
        throw Error("stream owns URL");
      },
      revokeUrl: () => {
        throw Error("stream owns URL");
      },
      audio: () => {
        const player = {
          currentTime: 0,
          paused: true,
          plays: 0,
          pauses: 0,
          async play() {
            this.plays++;
            this.paused = false;
          },
          pause() {
            this.pauses++;
            this.paused = true;
          },
        };
        players.push(player);
        return player;
      },
    },
  });
  return { controller, streams, players, states };
}
const aligned = (text) => ({
  alignment: {
    characters: [...text],
    characterStartTimesSeconds: [...text].map((_, i) => i / 10),
    characterEndTimesSeconds: [...text].map((_, i) => (i + 1) / 10),
  },
});
test("progressive playback starts before EOF, compensates only acknowledged speed and retains exact captions", async () => {
  const f = progressive();
  f.controller.setRate(0.8);
  const run = f.controller.speak("Hello, world.");
  const s = f.streams[0],
    p = f.players[0];
  s.callbacks.onFrame(aligned("Hello, world."));
  s.callbacks.onReady(0.8);
  await tick();
  assert.equal(p.plays, 1);
  assert.equal(p.playbackRate, 1);
  assert.equal(f.controller.pending, true);
  assert.equal(f.states.at(-1).caption, "Hello, world.");
  assert.deepEqual(f.states.at(-1).word, {
    from: 0,
    to: 6,
    start: 0,
    end: 0.6,
  });
  p.onpause();
  assert.equal(f.states.at(-1).word, null);
  p.onplaying();
  assert.equal(f.states.at(-1).word.from, 0);
  f.controller.setRate(1.2);
  assert.equal(p.playbackRate, 1.2 / 0.8);
  p.onwaiting();
  assert.equal(f.states.at(-1).word, null);
  p.currentTime = 0.8;
  s.load.resolve();
  await tick();
  p.onplaying();
  assert.deepEqual(f.states.at(-1).word, {
    from: 7,
    to: 13,
    start: 0.7,
    end: 1.3,
  });
  p.onseeking();
  p.currentTime = 0.1;
  p.onseeked();
  assert.equal(f.states.at(-1).word.from, 0);
  p.onended();
  await run;
  assert.equal(s.disposed, 1);
  assert.equal(p.ontimeupdate, null);
});
test("media ending before EOF cannot hide late stream failure", async () => {
  const f = progressive();
  const results = [];
  const run = f.controller.speak("Hello.", (error) => results.push(error));
  const s = f.streams[0],
    p = f.players[0];
  s.callbacks.onReady(null);
  await tick();
  p.onended();
  await tick();
  assert.equal(f.controller.pending, true);
  assert.deepEqual(results, []);
  s.load.reject(Error("truncated"));
  await run;
  assert.equal(results[0].cause.message, "truncated");
  assert.equal(s.disposed, 1);
});
test("progressive stop fences opening and playback callbacks and replay owns a fresh attachment", async () => {
  for (const ready of [false, true]) {
    const f = progressive();
    const first = f.controller.speak("Hello.");
    const s = f.streams[0],
      p = f.players[0];
    if (ready) s.callbacks.onReady(null);
    const latePlaying = p.onplaying;
    f.controller.stop();
    await first;
    assert.equal(s.disposed, 1);
    const replay = f.controller.speak("Hello.");
    s.callbacks.onReady(2);
    s.callbacks.onFrame(aligned("Hello."));
    latePlaying();
    s.load.reject(Error("cancelled"));
    await tick();
    assert.equal(f.states.at(-1).phase, "preparing");
    assert.equal(f.controller.pending, true);
    assert.equal(f.players[1].playbackRate, 1);
    const next = f.streams[1];
    next.callbacks.onReady(null);
    next.load.resolve();
    await tick();
    assert.equal(f.states.at(-1).word, null);
    f.players[1].onended();
    await replay;
    assert.equal(next.disposed, 1);
  }
});
test("synchronous attachment cancellation disposes the returned stream and consumes rejection", async () => {
  const f = progressive((s, controller) => {
    controller.stop();
    s.load.reject(Error("opening cancelled"));
  });
  await f.controller.speak("Hello.");
  await tick();
  assert.equal(f.streams[0].disposed, 1);
  assert.equal(f.controller.pending, false);
  assert.equal(f.players[0].plays, 0);
});
test("progressive invalid timing keeps plain captions; invalid speed or missing readiness fails", async () => {
  const f = progressive();
  const run = f.controller.speak("Hello.");
  const s = f.streams[0];
  s.callbacks.onFrame(aligned("Wrong."));
  s.callbacks.onReady(null);
  s.load.resolve();
  await tick();
  assert.equal(f.states.at(-1).word, null);
  assert.equal(f.states.at(-1).caption, "Hello.");
  f.players[0].onended();
  await run;
  for (const speed of [0, -1, NaN, Infinity, undefined]) {
    const bad = progressive();
    const pending = bad.controller.speak("Hello.");
    if (speed !== undefined) bad.streams[0].callbacks.onReady(speed);
    bad.streams[0].load.resolve();
    await assert.rejects(pending, (e) => e.code === "invalid-audio");
    assert.equal(bad.streams[0].disposed, 1);
  }
});

test("word animation stops on waiting and teardown", async () => {
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  const frames = new Map();
  let id = 0;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (key) => {
    frames.delete(key);
  };
  try {
    const f = progressive();
    const run = f.controller.speak("Hello.");
    f.streams[0].callbacks.onReady(null);
    await tick();
    assert.equal(frames.size, 1);
    f.players[0].onwaiting();
    assert.equal(frames.size, 0);
    f.players[0].onplaying();
    assert.equal(frames.size, 1);
    f.controller.stop();
    await run;
    assert.equal(frames.size, 0);
    f.streams[0].load.resolve();
    await tick();
    assert.equal(frames.size, 0);
  } finally {
    if (originalRequest) globalThis.requestAnimationFrame = originalRequest;
    else delete globalThis.requestAnimationFrame;
    if (originalCancel) globalThis.cancelAnimationFrame = originalCancel;
    else delete globalThis.cancelAnimationFrame;
  }
});

test("progressive autoplay rejection retains its cause and never synthesizes a retry", async () => {
  const f = progressive();
  const run = f.controller.speak("Hello.");
  f.players[0].play = () =>
    Promise.reject(new DOMException("Gesture required", "NotAllowedError"));
  f.streams[0].callbacks.onReady(null);
  await assert.rejects(
    run,
    (error) =>
      error.code === "playback" && error.cause.name === "NotAllowedError",
  );
  assert.equal(f.streams.length, 1);
  assert.equal(f.streams[0].disposed, 1);
  f.streams[0].load.reject(Error("cancelled"));
  await tick();
});

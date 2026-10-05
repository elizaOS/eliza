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

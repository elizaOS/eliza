import { describe, expect, it } from "vitest";
import {
  ASSISTANT_TIMING_DEFAULTS,
  type AssistantCapture,
  type AssistantClock,
  type AssistantHeard,
  type AssistantListenHandlers,
  type AssistantPorts,
  type AssistantReply,
  type AssistantState,
  type EndpointDecision,
  type EndpointRecord,
  type EndpointResult,
  splitSpokenSentences,
  VoiceAssistantSession,
} from "./voice-assistant-session";
import { createEndpointChain } from "./voice-endpoint-chain";

// Fake clock, capture, agent and speaker. These are controller contracts, not microphone,
// recognition, playback or latency evidence.
type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};
function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing item ${index}`);
  return item;
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: AssistantClock & { advance(ms: number): Promise<void> } = {
    now: () => now,
    setTimer: (callback, ms) => {
      const handle = ++id;
      timers.set(handle, { at: now + ms, callback });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        timers.delete(next[0]);
        now = next[1].at;
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
  return clock;
}

type Send = { turnId: string; text: string };
type Reply = {
  input: Parameters<AssistantPorts["send"]>[0];
  reply: Deferred<AssistantReply>;
};
type Speech = {
  input: Parameters<AssistantPorts["speak"]>[0];
  done: Deferred<void>;
};

function harness(
  options: {
    endpoint?: AssistantPorts["endpoint"];
    shouldRespond?: AssistantPorts["shouldRespond"];
    fullDuplex?: boolean;
    holdOpen?: Deferred<void>;
    /** The close of the nth capture (1-based); resolves at once when omitted. */
    close?: (capture: number) => Promise<void>;
    /** Playback settles only when the test settles it, also after an abort (slow cleanup). */
    manualSpeech?: boolean;
  } = {},
) {
  const clock = fakeClock();
  const log = {
    sends: [] as Send[],
    heard: [] as AssistantHeard[],
    states: [] as AssistantState[],
    turns: [] as [string, string][],
    endpoints: [] as EndpointRecord[],
    captures: 0,
    cancelled: 0,
    closed: 0,
    reopens: [] as (true | undefined)[],
    levels: [] as number[],
  };
  let mic: AssistantListenHandlers | undefined;
  let holdOpen = options.holdOpen;
  let current = true;
  const replies: Reply[] = [];
  const speeches: Speech[] = [];
  const ports: AssistantPorts = {
    conversationId: "room-1",
    assertCurrent: () => {
      if (!current) throw new DOMException("binding changed", "AbortError");
    },
    listen: async (handlers) => {
      const capture = ++log.captures;
      log.reopens.push(handlers.reopen);
      mic = handlers;
      if (holdOpen) await holdOpen.promise;
      return {
        fullDuplex: options.fullDuplex ?? true,
        close: async () => {
          log.closed++;
          await options.close?.(capture);
        },
        cancel: () => {
          log.cancelled++;
        },
      };
    },
    ...(options.shouldRespond ? { shouldRespond: options.shouldRespond } : {}),
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    send: (input) => {
      log.sends.push({ turnId: input.turnId, text: input.text });
      const reply = deferred<AssistantReply>();
      replies.push({ input, reply });
      input.signal.addEventListener(
        "abort",
        () => reply.reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      );
      return reply.promise;
    },
    speak: (input) => {
      const done = deferred<void>();
      speeches.push({ input, done });
      if (!options.manualSpeech)
        input.signal.addEventListener(
          "abort",
          () => done.reject(new DOMException("stopped", "AbortError")),
          { once: true },
        );
      return done.promise;
    },
    onHeard: (value) => log.heard.push(value),
    onLevel: (peak) => log.levels.push(peak),
    onState: (value) => log.states.push(value),
    onTurn: (event, turnId, detail) => {
      log.turns.push([event, turnId]);
      if (detail) log.endpoints.push(detail.endpoint);
    },
  };
  const session = new VoiceAssistantSession(ports, { clock });
  const answer = (
    index: number,
    text: string,
    extra: Partial<AssistantReply> = {},
  ) => {
    const { input, reply } = at(replies, index);
    reply.resolve({
      requestId: input.turnId,
      conversationId: "room-1",
      userMessageId: `u-${index}`,
      assistantMessageId: `a-${index}`,
      text,
      complete: true,
      ...extra,
    });
  };
  const microphone = () => {
    if (!mic) throw new Error("capture not open");
    return mic;
  };
  return {
    clock,
    log,
    session,
    replies,
    speeches,
    answer,
    mic: microphone,
    setCurrent(value: boolean) {
      current = value;
    },
    /** Holds every later listen until `gate` settles (a rejection fails that listen). */
    setHoldOpen(gate: Deferred<void> | undefined) {
      holdOpen = gate;
    },
    async say(text: string, durationMs = 400) {
      microphone().onSpeechStart(clock.now());
      await flush();
      await clock.advance(durationMs);
      microphone().onSpeechEnd(clock.now());
      await flush();
      microphone().onSegment(text);
      await flush();
    },
    phase: () => session.getSnapshot().phase,
  };
}

const { shortGapMs, longGapMs, endpointDeadlineMs, bargeInConfirmMs } =
  ASSISTANT_TIMING_DEFAULTS;

describe("VoiceAssistantSession endpointing", () => {
  it("submits once after the long gap; resumed speech before it continues the same turn", async () => {
    const h = harness();
    await h.session.start();
    expect(h.phase()).toBe("listening");
    await h.say("remind me to call");
    await h.clock.advance(longGapMs - 100);
    expect(h.log.sends).toHaveLength(0);
    await h.say("Sam at five");
    await h.clock.advance(longGapMs - 1);
    expect(h.log.sends).toHaveLength(0);
    await h.clock.advance(1);
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "remind me to call Sam at five",
    ]);
    expect(h.phase()).toBe("thinking");
  });

  it("finished submits at the short gap; slow or failing detectors never block the long gap; speech wins a racing decision", async () => {
    const finished = harness({ endpoint: async () => "finished" });
    await finished.session.start();
    await finished.say("what is the weather");
    await finished.clock.advance(shortGapMs);
    expect(finished.log.sends).toHaveLength(1);

    const never = harness({ endpoint: () => new Promise(() => {}) });
    await never.session.start();
    await never.say("what is the weather");
    await never.clock.advance(shortGapMs + endpointDeadlineMs);
    expect(never.log.sends).toHaveLength(0);
    await never.clock.advance(longGapMs);
    expect(never.log.sends).toHaveLength(1);

    const failing = harness({
      endpoint: async () => {
        throw Error("model unavailable");
      },
    });
    await failing.session.start();
    await failing.say("hello there");
    await failing.clock.advance(longGapMs);
    expect(failing.log.sends).toHaveLength(1);

    const decision = deferred<EndpointDecision>();
    const racing = harness({ endpoint: () => decision.promise });
    await racing.session.start();
    await racing.say("turn on the");
    await racing.clock.advance(shortGapMs);
    racing.mic().onSpeechStart(racing.clock.now());
    await flush();
    decision.resolve("finished");
    await flush();
    expect(racing.log.sends).toHaveLength(0);
    await racing.clock.advance(300);
    racing.mic().onSpeechEnd(racing.clock.now());
    racing.mic().onSegment("kitchen lights");
    await flush();
    await racing.clock.advance(longGapMs);
    expect(racing.log.sends.map((send) => send.text)).toEqual([
      "turn on the kitchen lights",
    ]);
  });

  it("records which path submitted each turn without transcript text", async () => {
    const complete = harness({
      endpoint: async (): Promise<EndpointResult> => ({
        decision: "finished",
        latencyMs: 41,
      }),
    });
    await complete.session.start();
    await complete.say("what is the weather in Lisbon");
    await complete.clock.advance(shortGapMs);
    expect(complete.log.endpoints).toEqual([
      { by: "semantic", semantic: "complete", latencyMs: 41 },
    ]);
    expect(JSON.stringify(complete.log.endpoints)).not.toContain("Lisbon");

    const incomplete = harness({
      endpoint: async () => ({ decision: "continue", latencyMs: 12 }),
    });
    await incomplete.session.start();
    await incomplete.say("remind me to");
    await incomplete.clock.advance(longGapMs - 1);
    expect(incomplete.log.sends).toHaveLength(0);
    await incomplete.clock.advance(1);
    expect(incomplete.log.endpoints).toEqual([
      { by: "gap", semantic: "incomplete", latencyMs: 12 },
    ]);

    const unavailable = harness({
      endpoint: async () => ({ decision: "unavailable", reason: "unscored" }),
    });
    await unavailable.session.start();
    await unavailable.say("turn off the lights");
    await unavailable.clock.advance(longGapMs - 1);
    expect(unavailable.log.sends).toHaveLength(0);
    await unavailable.clock.advance(1);
    expect(unavailable.log.endpoints).toEqual([
      { by: "gap", semantic: "unavailable", reason: "unscored" },
    ]);

    const error = harness({
      endpoint: () =>
        Promise.reject(Object.assign(Error("502"), { status: 502 })),
    });
    await error.session.start();
    await error.say("call mom");
    await error.clock.advance(longGapMs);
    expect(error.log.endpoints).toEqual([{ by: "gap", semantic: "error" }]);

    const signals: AbortSignal[] = [];
    const slow = harness({
      endpoint: (_text, signal) => {
        signals.push(signal);
        return new Promise(() => {});
      },
    });
    await slow.session.start();
    await slow.say("play some music");
    await slow.clock.advance(shortGapMs + endpointDeadlineMs);
    expect(signals[0]?.aborted).toBe(true);
    await slow.clock.advance(longGapMs);
    expect(slow.log.endpoints).toEqual([{ by: "gap", semantic: "timeout" }]);

    const absent = harness();
    await absent.session.start();
    await absent.say("hello");
    await absent.clock.advance(longGapMs);
    expect(absent.log.endpoints).toEqual([
      { by: "gap", semantic: "not-asked" },
    ]);
  });

  it("aborts a call on resumed speech, keeps one call in flight and asks the next utterance afresh", async () => {
    const calls: {
      text: string;
      signal: AbortSignal;
      d: Deferred<EndpointResult>;
    }[] = [];
    const h = harness({
      endpoint: (text, signal) => {
        const d = deferred<EndpointResult>();
        calls.push({ text, signal, d });
        return d.promise;
      },
    });
    await h.session.start();
    await h.say("set a timer for");
    await h.clock.advance(shortGapMs);
    expect(calls).toHaveLength(1);
    h.mic().onSpeechStart(h.clock.now());
    await flush();
    expect(calls[0]?.signal.aborted).toBe(true);
    calls[0]?.d.resolve({ decision: "finished", latencyMs: 5 });
    await flush();
    expect(h.log.sends).toHaveLength(0);
    await h.clock.advance(400);
    h.mic().onSpeechEnd(h.clock.now());
    h.mic().onSegment("ten minutes");
    await flush();
    await h.clock.advance(shortGapMs);
    expect(calls.map((call) => call.text)).toEqual([
      "set a timer for",
      "set a timer for ten minutes",
    ]);
    await h.session.setMuted(true);
    await flush();
    await h.clock.advance(shortGapMs);
    expect(calls.filter((call) => !call.signal.aborted)).toHaveLength(1);
    calls.at(-1)?.d.resolve({ decision: "continue" });
    await flush();
    calls[1]?.d.resolve({ decision: "finished" });
    await flush();
    expect(h.log.sends).toHaveLength(0);
    await h.clock.advance(longGapMs);
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "set a timer for ten minutes",
    ]);
    expect(h.log.endpoints).toEqual([
      { by: "gap", semantic: "incomplete", latencyMs: 300 },
    ]);
  });
});

describe("VoiceAssistantSession with the end-of-turn chain", () => {
  it("records the chain stage that answered, and resumed speech cancels a pending Clef submit", async () => {
    const clefCalls: Deferred<unknown>[] = [];
    const chain = createEndpointChain({
      local: async () => ({ decision: "unavailable", reason: "ram-pressure" }),
      // The chain measures Clef's round trip on its own clock; fixed here.
      now: () => 0,
      clef: {
        enabled: true,
        timeoutMs: 10_000,
        client: () => {
          const d = deferred<unknown>();
          clefCalls.push(d);
          return d.promise;
        },
      },
    });
    const h = harness({ endpoint: chain });
    await h.session.start();
    await h.say("set a timer for");
    await h.clock.advance(shortGapMs);
    expect(clefCalls).toHaveLength(1);
    // Speech resumes before Clef answers: its yes is dropped and nothing is sent.
    h.mic().onSpeechStart(h.clock.now());
    await flush();
    at(clefCalls, 0).resolve({
      status: "ok",
      kind: "turn",
      complete: true,
      completeProbability: 0.9,
    });
    await flush();
    expect(h.log.sends).toHaveLength(0);
    await h.clock.advance(400);
    h.mic().onSpeechEnd(h.clock.now());
    h.mic().onSegment("ten minutes");
    await flush();
    await h.clock.advance(shortGapMs);
    expect(clefCalls).toHaveLength(2);
    at(clefCalls, 1).resolve({
      status: "ok",
      kind: "turn",
      complete: true,
      completeProbability: 0.8,
    });
    await flush();
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "set a timer for ten minutes",
    ]);
    expect(h.log.endpoints).toEqual([
      { by: "semantic", semantic: "complete", latencyMs: 0, path: "clef" },
    ]);

    // Clef unavailable is never a yes: the long gap submits and the record names the stage.
    const off = harness({
      endpoint: createEndpointChain({
        local: async () => ({ decision: "unavailable", reason: "unscored" }),
        clef: {
          enabled: true,
          client: async () => ({ status: "unavailable", reason: "disabled" }),
        },
      }),
    });
    await off.session.start();
    await off.say("turn off the lights");
    await off.clock.advance(longGapMs - 1);
    expect(off.log.sends).toHaveLength(0);
    await off.clock.advance(1);
    expect(off.log.endpoints).toEqual([
      {
        by: "gap",
        semantic: "unavailable",
        reason: "clef-disabled",
        path: "clef",
      },
    ]);

    const local = harness({
      endpoint: createEndpointChain({
        local: async () => ({ decision: "finished", latencyMs: 9 }),
      }),
    });
    await local.session.start();
    await local.say("what time is it");
    await local.clock.advance(shortGapMs);
    expect(local.log.endpoints).toEqual([
      { by: "semantic", semantic: "complete", latencyMs: 9, path: "local" },
    ]);
  });
});

describe("VoiceAssistantSession interruption and heard content", () => {
  it("never interrupts a pending request by voice; speech after the reply played is the next turn", async () => {
    const h = harness();
    await h.session.start();
    await h.say("book a table");
    await h.clock.advance(longGapMs);
    expect(h.log.sends).toHaveLength(1);
    const first = at(h.replies, 0);
    // Held speech on the closed capture confirms neither by time nor by transcript.
    h.mic().onSpeechStart(h.clock.now());
    await flush();
    await h.clock.advance(bargeInConfirmMs * 2);
    h.mic().onSpeechEnd(h.clock.now());
    h.mic().onSegment("for four people");
    await flush();
    await h.clock.advance(longGapMs);
    expect(first.input.signal.aborted).toBe(false);
    expect(h.phase()).toBe("thinking");
    expect(h.log.sends).toHaveLength(1);
    expect(h.log.turns.map(([event]) => event)).toEqual(["submitted"]);
    h.answer(0, "Which restaurant?");
    await flush();
    h.speeches[0]?.input.onStarted();
    h.speeches[0]?.done.resolve();
    await flush();
    expect(h.log.captures).toBe(2);
    await h.say("for four people");
    await h.clock.advance(longGapMs);
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "book a table",
      "for four people",
    ]);
    expect(h.log.sends[1]?.turnId).not.toBe(h.log.sends[0]?.turnId);
  });

  it("accepted speech never stops playback; Stop speaking keeps only the sentences that finished", async () => {
    const h = harness();
    await h.session.start();
    await h.say("tell me about my day");
    await h.clock.advance(longGapMs);
    h.answer(
      0,
      "You have three meetings today. The first starts at nine with Priya. Then lunch with Sam at noon.",
    );
    await flush();
    h.speeches[0]?.input.onStarted();
    await flush();
    expect(h.phase()).toBe("speaking");
    h.speeches[0]?.done.resolve();
    await flush();
    h.speeches[1]?.input.onStarted();
    await flush();
    await h.say("wait", bargeInConfirmMs * 2);
    expect(h.speeches[1]?.input.signal.aborted).toBe(false);
    expect(h.session.interruptSpeech()).toBe(true);
    expect(h.speeches[1]?.input.signal.aborted).toBe(true);
    expect(h.speeches).toHaveLength(2);
    expect(h.log.heard).toEqual([
      {
        turnId: h.log.sends[0]?.turnId,
        replyId: "a-0",
        heard: "You have three meetings today.",
        unheard:
          "The first starts at nine with Priya. Then lunch with Sam at noon.",
        interrupted: true,
      },
    ]);
    expect(h.phase()).toBe("listening");
    h.speeches[1]?.input.onStarted();
    await flush();
    expect(h.phase()).toBe("listening");
  });

  it("Stop speaking interrupts and reopens the microphone; a reply played to the end is heard in full", async () => {
    const h = harness();
    await h.session.start();
    await h.say("what time is it");
    await h.clock.advance(longGapMs);
    h.answer(0, "It is nine thirty in the morning.");
    await flush();
    expect(h.session.interruptSpeech()).toBe(false);
    h.speeches[0]?.input.onStarted();
    await flush();
    expect(h.session.interruptSpeech()).toBe(true);
    expect(h.log.heard.at(-1)).toMatchObject({ heard: "", interrupted: true });
    await flush();
    expect(h.log.captures).toBe(2);
    expect(h.log.reopens).toEqual([undefined, true]);
    await h.say("and tomorrow");
    await h.clock.advance(longGapMs);
    h.answer(1, "Tomorrow is Thursday.");
    await flush();
    h.speeches[1]?.input.onStarted();
    h.speeches[1]?.done.resolve();
    await flush();
    expect(h.log.heard.at(-1)).toEqual({
      turnId: h.log.sends[1]?.turnId,
      replyId: "a-1",
      heard: "Tomorrow is Thursday.",
      unheard: "",
      interrupted: false,
    });
    expect(h.log.turns.map(([event]) => event)).toEqual([
      "submitted",
      "first-audio",
      "interrupted",
      "submitted",
      "first-audio",
      "finished",
    ]);
  });

  it("marks a reply whose playback failed, so a speech failure is not reported as an interruption", async () => {
    const h = harness();
    await h.session.start();
    await h.say("what time is it");
    await h.clock.advance(longGapMs);
    h.answer(0, "It is nine thirty. The sun is up.");
    await flush();
    h.speeches[0]?.done.reject(
      Object.assign(Error("speech refused"), { status: 429 }),
    );
    await flush();
    expect(h.log.heard).toEqual([
      {
        turnId: h.log.sends[0]?.turnId,
        replyId: "a-0",
        heard: "",
        unheard: "It is nine thirty. The sun is up.",
        interrupted: true,
        playbackFailed: true,
      },
    ]);
  });

  it("never hears the reply's own echo while it plays; the gate still rejects its tail after the reopen", async () => {
    const echo: AssistantPorts["shouldRespond"] = (text, context) =>
      !(context.agentSpeaking || context.replyAgeMs < 9000) ||
      !context.recentAgentReply.toLowerCase().includes(text.toLowerCase());
    const h = harness({ shouldRespond: echo });
    await h.session.start();
    await h.say("read my reminder");
    await h.clock.advance(longGapMs);
    h.answer(0, "Your reminder says to water the plants before you leave.");
    await flush();
    h.speeches[0]?.input.onStarted();
    await flush();
    await h.say("water the plants");
    expect(h.speeches[0]?.input.signal.aborted).toBe(false);
    expect(h.phase()).toBe("speaking");
    h.speeches[0]?.done.resolve();
    await flush();
    expect(h.log.captures).toBe(2);
    await h.say("water the plants");
    await h.clock.advance(longGapMs * 2);
    expect(h.log.sends).toHaveLength(1);
    expect(h.log.heard.at(-1)?.interrupted).toBe(false);
  });

  it("speech during playback never interrupts, with or without an echo canceller; Stop speaking still does", async () => {
    for (const fullDuplex of [false, true]) {
      const h = harness({ fullDuplex });
      await h.session.start();
      await h.say("what is the forecast");
      await h.clock.advance(longGapMs);
      h.answer(0, "Sunny with a light breeze all afternoon.");
      await flush();
      h.speeches[0]?.input.onStarted();
      await flush();
      await h.say("no wait, tomorrow", bargeInConfirmMs * 2);
      expect(h.speeches[0]?.input.signal.aborted).toBe(false);
      expect(h.session.interruptSpeech()).toBe(true);
      await h.clock.advance(longGapMs * 2);
      expect(h.log.sends).toHaveLength(1);
    }
  });
});

describe("VoiceAssistantSession busy hold", () => {
  it("closes input at submission and keeps it closed through thinking, every sentence and drain; reopens once after the last playback", async () => {
    const closing = deferred();
    const h = harness({ close: () => closing.promise });
    await h.session.start();
    await h.say("what is on today");
    await h.clock.advance(longGapMs);
    expect(h.log).toMatchObject({ closed: 1, cancelled: 0, captures: 1 });
    const closed = h.mic();
    // Speech, level and segments on the closed capture never act (no barge-in, no tentative turn).
    const speakOnClosed = async (text: string) => {
      closed.onSpeechStart(h.clock.now());
      closed.onLevel?.(0.8);
      await h.clock.advance(bargeInConfirmMs * 2);
      closed.onSpeechEnd(h.clock.now());
      closed.onSegment(text);
      await flush();
    };
    await speakOnClosed("cancel that");
    // Not held, and nothing sent (so no ack can play), until the capture's own close fulfilled.
    expect(h.session.getSnapshot()).toEqual({
      phase: "thinking",
      transcript: "what is on today",
    });
    expect(h.log.sends).toHaveLength(0);
    closing.resolve();
    await flush();
    expect(h.log.sends).toHaveLength(1);
    const reply = at(h.replies, 0);
    expect(h.session.getSnapshot()).toMatchObject({
      phase: "thinking",
      inputHeld: true,
    });
    await speakOnClosed("never mind");
    expect(reply.input.signal.aborted).toBe(false);
    h.answer(0, "You have two meetings today. The first one starts at nine.");
    await flush();
    at(h.speeches, 0).input.onStarted();
    await flush();
    await speakOnClosed("stop");
    at(h.speeches, 0).done.resolve();
    await flush();
    await speakOnClosed("stop");
    at(h.speeches, 1).input.onStarted();
    await flush();
    await speakOnClosed("stop");
    expect(h.speeches.map((speech) => speech.input.signal.aborted)).toEqual([
      false,
      false,
    ]);
    expect(h.log.levels).toEqual([]);
    expect(h.log.captures).toBe(1);
    expect(h.session.getSnapshot()).toEqual({
      phase: "speaking",
      replyId: "a-0",
      inputHeld: true,
    });
    // The reopen waits for the last playback and stays held until that open resolved.
    const reopening = deferred();
    h.setHoldOpen(reopening);
    at(h.speeches, 1).done.resolve();
    await flush();
    expect(h.log.captures).toBe(2);
    expect(h.log.reopens).toEqual([undefined, true]);
    expect(h.session.getSnapshot()).toEqual({
      phase: "listening",
      inputHeld: true,
    });
    reopening.resolve();
    await flush();
    expect(h.session.getSnapshot()).toEqual({ phase: "listening" });
    expect(h.log.sends).toHaveLength(1);
    expect(h.log.heard.at(-1)).toMatchObject({ interrupted: false });
  });

  it("a deferred close: nothing is sent (so no ack inside send) and nothing is held until it fulfilled", async () => {
    const closing = deferred();
    const slow = harness({ close: () => closing.promise });
    await slow.session.start();
    await slow.say("what time is it");
    await slow.clock.advance(longGapMs + 10_000);
    expect(slow.log.sends).toHaveLength(0);
    expect(slow.log.states.some((state) => state.inputHeld)).toBe(false);
    closing.resolve();
    await flush();
    expect(slow.log.sends).toHaveLength(1);
    expect(slow.session.getSnapshot()).toMatchObject({ inputHeld: true });
    slow.answer(0, "It is nine.");
    await flush();
    at(slow.speeches, 0).done.resolve();
    await flush();
    expect(slow.log.reopens).toEqual([undefined, true]);
    expect(slow.session.getSnapshot()).toEqual({ phase: "listening" });
  });

  it("a rejected close, at once or late (Cloud's final timeout), also AbortError-named, ends the conversation; nothing is sent, spoken or reopened", async () => {
    for (const [failure, lateMs] of [
      [Error("close not confirmed"), 0],
      [Error("Cloud transcription did not finish after mute."), 2_500],
      [new DOMException("Cloud speech stopped", "AbortError"), 0],
    ] as const) {
      const closing = deferred();
      const h = harness({ close: () => closing.promise });
      await h.session.start();
      await h.say("what time is it");
      await h.clock.advance(longGapMs + lateMs);
      expect(h.log.sends).toHaveLength(0);
      closing.reject(failure);
      await flush();
      expect(h.session.getSnapshot()).toMatchObject({
        phase: "error",
        error: { code: "capture" },
      });
      await h.clock.advance(longGapMs * 2);
      await h.session.setMuted(true);
      await h.session.setMuted(false);
      expect(h.log).toMatchObject({ captures: 1, closed: 1 });
      expect(h.log.sends).toHaveLength(0);
      expect(h.speeches).toHaveLength(0);
      expect(h.log.states.some((state) => state.inputHeld)).toBe(false);
    }
  });

  it("a hung close: the turn is never sent and the microphone never reopens; Stop ends it", async () => {
    const hung = harness({ close: () => new Promise<void>(() => {}) });
    await hung.session.start();
    await hung.say("what time is it");
    await hung.clock.advance(longGapMs + 60_000);
    // Mute and Unmute wait on that close too: neither opens a capture.
    void hung.session.setMuted(true);
    void hung.session.setMuted(false);
    await flush();
    expect(hung.log.sends).toHaveLength(0);
    expect(hung.speeches).toHaveLength(0);
    expect(hung.log.captures).toBe(1);
    expect(hung.session.getSnapshot()).toMatchObject({
      phase: "thinking",
      transcript: "what time is it",
    });
    expect(hung.session.getSnapshot().inputHeld).toBeUndefined();
    void hung.session.stop();
    await flush();
    expect(hung.session.getSnapshot()).toEqual({ phase: "idle" });
    await hung.clock.advance(longGapMs * 2);
    expect(hung.log).toMatchObject({ captures: 1, cancelled: 1 });
    expect(hung.log.sends).toHaveLength(0);
  });

  it("a Mute close still in flight at submission is one the turn waits on: its failure ends it", async () => {
    const muteClose = deferred();
    const muted = harness({ close: () => muteClose.promise });
    await muted.session.start();
    muted.mic().onSpeechStart(muted.clock.now());
    await flush();
    void muted.session.setMuted(true);
    muted.mic().onSpeechEnd(muted.clock.now());
    muted.mic().onSegment("turn off the alarm");
    await flush();
    await muted.clock.advance(longGapMs);
    expect(muted.log.sends).toHaveLength(0);
    muteClose.reject(Error("close not confirmed"));
    await flush();
    expect(muted.session.getSnapshot()).toMatchObject({
      phase: "error",
      error: { code: "capture" },
    });
    expect(muted.log.sends).toHaveLength(0);
    expect(muted.log.captures).toBe(1);
  });

  it("keeps manual Mute independent: Mute during the hold stays muted after release; Unmute during it opens nothing until release", async () => {
    const h = harness();
    await h.session.start();
    await h.say("what is the weather");
    await h.clock.advance(longGapMs);
    await h.session.setMuted(true);
    expect(h.session.getSnapshot()).toMatchObject({
      phase: "thinking",
      muted: true,
      inputHeld: true,
    });
    expect(h.log.closed).toBe(1);
    h.answer(0, "Sunny.");
    await flush();
    at(h.speeches, 0).done.resolve();
    await flush();
    expect(h.log.captures).toBe(1);
    expect(h.session.getSnapshot()).toEqual({
      phase: "listening",
      muted: true,
    });
    await h.session.setMuted(false);
    expect(h.log.captures).toBe(2);
    expect(h.log.reopens).toEqual([undefined, undefined]);

    const cycles = harness();
    await cycles.session.start();
    await cycles.say("what is the weather");
    await cycles.clock.advance(longGapMs);
    for (let i = 0; i < 3; i++) {
      await cycles.session.setMuted(true);
      await cycles.session.setMuted(false);
    }
    expect(cycles.log.captures).toBe(1);
    expect(cycles.session.getSnapshot()).toMatchObject({
      phase: "thinking",
      inputHeld: true,
    });
    cycles.answer(0, "Sunny.");
    await flush();
    at(cycles.speeches, 0).done.resolve();
    await flush();
    expect(cycles.log.captures).toBe(2);
    expect(cycles.log.reopens).toEqual([undefined, true]);

    // Muted before submission: sent and held once that Mute close fulfilled; Unmute waits for release.
    const muteClose = deferred();
    const m = harness({ close: () => muteClose.promise });
    await m.session.start();
    m.mic().onSpeechStart(m.clock.now());
    await flush();
    const muting = m.session.setMuted(true);
    m.mic().onSpeechEnd(m.clock.now());
    m.mic().onSegment("turn off the alarm");
    await flush();
    await m.clock.advance(longGapMs);
    expect(m.log.sends).toHaveLength(0);
    muteClose.resolve();
    await muting;
    await flush();
    expect(m.log.sends).toHaveLength(1);
    expect(m.session.getSnapshot()).toMatchObject({
      phase: "thinking",
      muted: true,
      inputHeld: true,
    });
    await m.session.setMuted(false);
    expect(m.log.captures).toBe(1);
    expect(m.session.getSnapshot()).toMatchObject({ inputHeld: true });
    expect(m.session.muted).toBe(false);
    m.answer(0, "Alarm off.");
    await flush();
    at(m.speeches, 0).done.resolve();
    await flush();
    expect(m.log.captures).toBe(2);
    expect(m.log.reopens).toEqual([undefined, true]);
  });

  it("never reopens after Stop during thinking, speaking or the review pause, also when the reply settles late", async () => {
    for (const stage of ["thinking", "speaking", "review"] as const) {
      const h = harness();
      await h.session.start();
      await h.say("what is next");
      await h.clock.advance(longGapMs);
      if (stage === "review")
        h.answer(0, "Share it?", {
          complete: false,
          awaitingUserInput: { proposalId: "p-1", digest: "d-1" },
        });
      if (stage === "speaking") h.answer(0, "Done.");
      await flush();
      if (stage === "speaking") at(h.speeches, 0).input.onStarted();
      await h.session.stop();
      h.answer(0, "Late.");
      h.speeches[0]?.done.resolve();
      await flush();
      await h.clock.advance(longGapMs * 2);
      expect(h.log.captures).toBe(1);
      expect(h.session.getSnapshot()).toEqual({ phase: "idle" });
    }
  });

  it("never sends or reopens when the binding changed while the turn waited for its close; the binding fence stops it", async () => {
    const closing = deferred();
    const binding = harness({ close: () => closing.promise });
    await binding.session.start();
    await binding.say("what is next");
    await binding.clock.advance(longGapMs);
    binding.setCurrent(false);
    closing.resolve();
    await flush();
    await binding.clock.advance(longGapMs * 2);
    expect(binding.log.sends).toHaveLength(0);
    expect(binding.log.captures).toBe(1);
    binding.session.recheck();
    await flush();
    expect(binding.phase()).toBe("idle");
    expect(binding.log.captures).toBe(1);
  });

  it("fails at once when the closed capture's transport ends while held, muted or not", async () => {
    for (const muted of [false, true]) {
      const h = harness();
      await h.session.start();
      await h.say("what is next");
      await h.clock.advance(longGapMs);
      if (muted) await h.session.setMuted(true);
      const reply = at(h.replies, 0);
      h.mic().onEnd(Object.assign(Error("speech closed"), { code: "expired" }));
      await flush();
      expect(reply.input.signal.aborted).toBe(true);
      expect(h.phase()).toBe("error");
      h.answer(0, "Late.");
      await flush();
      await h.clock.advance(longGapMs * 2);
      expect(h.log.captures).toBe(1);
      expect(h.speeches).toHaveLength(0);
    }
  });

  it("ends the conversation when the reopen is refused (a call or pause on the bridge), after one attempt", async () => {
    const refused = harness();
    await refused.session.start();
    await refused.say("what is next");
    await refused.clock.advance(longGapMs);
    const open = deferred();
    open.reject(
      Object.assign(Error("Voice was interrupted"), { code: "call-active" }),
    );
    refused.setHoldOpen(open);
    refused.answer(0, "Done.");
    await flush();
    at(refused.speeches, 0).done.resolve();
    await flush();
    expect(refused.log.reopens).toEqual([undefined, true]);
    expect(refused.session.getSnapshot()).toMatchObject({
      phase: "error",
      error: { code: "call-active" },
    });
    await refused.clock.advance(longGapMs * 2);
    expect(refused.log.captures).toBe(2);
  });

  it("an AbortError that is not the session's own leaves the turn held with no reopen; only Stop clears it", async () => {
    const owned = harness();
    await owned.session.start();
    await owned.say("what is next");
    await owned.clock.advance(longGapMs);
    owned.answer(0, "Done.");
    await flush();
    at(owned.speeches, 0).done.reject(
      new DOMException("speech retired", "AbortError"),
    );
    await flush();
    await owned.clock.advance(longGapMs * 2);
    expect(owned.log.captures).toBe(1);
    expect(owned.session.getSnapshot()).toMatchObject({
      phase: "thinking",
      inputHeld: true,
    });
    await owned.session.stop();
    await flush();
    expect(owned.session.getSnapshot()).toEqual({ phase: "idle" });
    expect(owned.log.captures).toBe(1);
  });

  it("closes a capture that finishes opening after submission and holds only after that close", async () => {
    const closes = [deferred(), deferred()];
    const h = harness({ close: (capture) => at(closes, capture - 1).promise });
    await h.session.start();
    const first = h.mic();
    first.onSpeechStart(h.clock.now());
    await flush();
    const muting = h.session.setMuted(true);
    // Unmute while the muted capture still finalizes; the new capture is slow to open.
    const opening = deferred();
    h.setHoldOpen(opening);
    const unmuting = h.session.setMuted(false);
    first.onSpeechEnd(h.clock.now());
    first.onSegment("turn off the alarm");
    at(closes, 0).resolve();
    await muting;
    await flush();
    expect(h.log.captures).toBe(2);
    // The final submits while the new capture is still opening; it is sent only after that
    // capture arrived and its close fulfilled.
    await h.clock.advance(longGapMs);
    expect(h.log.sends).toHaveLength(0);
    opening.resolve();
    await unmuting;
    await flush();
    expect(h.log).toMatchObject({ closed: 2, cancelled: 0 });
    expect(h.session.getSnapshot().inputHeld).toBeUndefined();
    expect(h.log.sends).toHaveLength(0);
    at(closes, 1).resolve();
    await flush();
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "turn off the alarm",
    ]);
    expect(h.session.getSnapshot()).toMatchObject({
      phase: "thinking",
      inputHeld: true,
    });
    h.mic().onSpeechStart(h.clock.now());
    await h.clock.advance(bargeInConfirmMs * 2);
    expect(at(h.replies, 0).input.signal.aborted).toBe(false);
  });

  it("Stop speaking releases once, only after the interrupted playback settled; it does nothing while thinking", async () => {
    const h = harness({ manualSpeech: true });
    await h.session.start();
    await h.say("tell me a story");
    await h.clock.advance(longGapMs);
    expect(h.session.interruptSpeech()).toBe(false);
    await flush();
    expect(h.log.captures).toBe(1);
    expect(at(h.replies, 0).input.signal.aborted).toBe(false);
    h.answer(0, "Once upon a time there was a fox. It lived in the woods.");
    await flush();
    at(h.speeches, 0).input.onStarted();
    await flush();
    expect(h.session.interruptSpeech()).toBe(true);
    expect(at(h.speeches, 0).input.signal.aborted).toBe(true);
    expect(h.log.heard).toEqual([
      {
        turnId: h.log.sends[0]?.turnId,
        replyId: "a-0",
        heard: "",
        unheard: "Once upon a time there was a fox. It lived in the woods.",
        interrupted: true,
      },
    ]);
    // Playback is still stopping: input stays closed, also for an Unmute meanwhile.
    await h.session.setMuted(true);
    await h.session.setMuted(false);
    await h.clock.advance(longGapMs);
    expect(h.log.captures).toBe(1);
    expect(h.session.getSnapshot()).toMatchObject({
      phase: "listening",
      inputHeld: true,
    });
    expect(h.session.interruptSpeech()).toBe(false);
    at(h.speeches, 0).done.reject(new DOMException("stopped", "AbortError"));
    await flush();
    expect(h.log.captures).toBe(2);
    expect(h.log.reopens).toEqual([undefined, true]);
    expect(h.session.getSnapshot()).toEqual({ phase: "listening" });
    expect(h.log.turns.map(([event]) => event)).toEqual([
      "submitted",
      "first-audio",
      "interrupted",
    ]);
  });

  it("captures, endpoints and sends the turn after release and holds it again; a silent reply releases at once", async () => {
    const h = harness({ endpoint: async () => "finished" });
    await h.session.start();
    await h.say("what is the weather");
    await h.clock.advance(shortGapMs);
    h.answer(0, "Sunny.");
    await flush();
    at(h.speeches, 0).done.resolve();
    await flush();
    expect(h.log.captures).toBe(2);
    await h.say("and tomorrow");
    await h.clock.advance(shortGapMs);
    expect(h.log.sends.map((send) => send.text)).toEqual([
      "what is the weather",
      "and tomorrow",
    ]);
    expect(h.log.endpoints.map((record) => record.by)).toEqual([
      "semantic",
      "semantic",
    ]);
    expect(h.log.closed).toBe(2);
    expect(h.session.getSnapshot()).toMatchObject({
      phase: "thinking",
      inputHeld: true,
    });
    h.answer(1, "");
    await flush();
    expect(h.speeches).toHaveLength(1);
    expect(h.log.captures).toBe(3);
    expect(h.log.reopens).toEqual([undefined, true, true]);
    expect(h.session.getSnapshot()).toEqual({ phase: "listening" });
  });
});

describe("VoiceAssistantSession lifecycle and authority", () => {
  it("closes a microphone that finishes opening after Mute", async () => {
    const holdOpen = deferred();
    const h = harness({ holdOpen });
    const starting = h.session.start();
    await flush();
    const muting = h.session.setMuted(true);
    holdOpen.resolve();
    await starting;
    await muting;
    expect(h.log.closed).toBe(1);
    expect(h.session.muted).toBe(true);
    await h.session.setMuted(false);
    expect(h.log.captures).toBe(2);
  });

  it("stops on a binding change: capture discarded, nothing sent, late callbacks ignored", async () => {
    const h = harness();
    await h.session.start();
    await h.say("send a message to");
    h.setCurrent(false);
    h.session.recheck();
    await flush();
    expect(h.phase()).toBe("idle");
    expect(h.log.cancelled).toBe(1);
    h.mic().onSegment("Alex");
    h.mic().onSpeechStart(h.clock.now());
    await h.clock.advance(longGapMs * 3);
    expect(h.log.sends).toHaveLength(0);

    const g = harness();
    await g.session.start();
    await g.say("what is on my calendar");
    await g.clock.advance(longGapMs);
    g.setCurrent(false);
    g.session.recheck();
    await flush();
    expect(g.replies[0]?.input.signal.aborted).toBe(true);
    g.answer(0, "You are free all day.");
    await flush();
    expect(g.speeches).toHaveLength(0);
  });

  it("Stop discards an unsent utterance; Mute finalizes speech up to the mute", async () => {
    const h = harness();
    await h.session.start();
    await h.say("cancel my");
    await h.session.stop();
    await h.clock.advance(longGapMs * 2);
    expect(h.log.sends).toHaveLength(0);

    const m = harness();
    await m.session.start();
    m.mic().onSpeechStart(m.clock.now());
    await flush();
    const muting = m.session.setMuted(true);
    m.mic().onSpeechEnd(m.clock.now());
    m.mic().onSegment("turn off the alarm");
    await muting;
    expect(m.log.closed).toBe(1);
    await m.clock.advance(longGapMs);
    expect(m.log.sends.map((send) => send.text)).toEqual([
      "turn off the alarm",
    ]);
    m.mic().onSpeechStart(m.clock.now());
    await flush();
    expect(m.replies[0]?.input.signal.aborted).toBe(false);
    // Unmuting while the submitted turn is busy opens the microphone once its reply played.
    await m.session.setMuted(false);
    expect(m.log.captures).toBe(1);
    m.answer(0, "Alarm off.");
    await flush();
    m.speeches[0]?.done.resolve();
    await flush();
    expect(m.log.captures).toBe(2);
  });

  it("Stop cancels a muted capture that is still finalizing", async () => {
    const h = harness();
    await h.session.start();
    let cancels = 0;
    const closing = deferred();
    const capture: AssistantCapture = {
      fullDuplex: true,
      close: () => closing.promise,
      cancel: () => {
        cancels++;
        closing.resolve();
      },
    };
    (h.session as unknown as { capture: AssistantCapture }).capture = capture;
    void h.session.setMuted(true);
    await flush();
    await h.session.stop();
    expect(cancels).toBe(1);
  });

  it("never approves: a reply with proposals ends voice without speaking it", async () => {
    const h = harness();
    await h.session.start();
    await h.say("delete my dentist appointment");
    await h.clock.advance(longGapMs);
    h.answer(0, "Review the deletion below.", { complete: false });
    await flush();
    expect(h.speeches).toHaveLength(0);
    expect(h.phase()).toBe("error");
    expect(h.log).toMatchObject({ captures: 1, closed: 1, cancelled: 0 });
  });

  it("keeps the microphone closed (never cancelled) through an owner-input pause and the resumed reply, then reopens once", async () => {
    const h = harness();
    await h.session.start();
    await h.say("summarize my packing note");
    await h.clock.advance(longGapMs);
    h.answer(0, "Share the note?", {
      complete: false,
      awaitingUserInput: { proposalId: "p-1", digest: "d-1" },
    });
    await flush();
    const state = h.session.getSnapshot();
    expect(state).toMatchObject({
      phase: "awaiting-user-input",
      inputHeld: true,
    });
    expect(h.log).toMatchObject({ captures: 1, closed: 1, cancelled: 0 });
    // Speech during the review is never sent.
    await h.say("yes share it");
    await h.clock.advance(longGapMs);
    expect(h.log.sends).toHaveLength(1);
    const pause = state.awaitingUserInput;
    if (!pause) throw new Error("expected a pause");
    const reply = {
      requestId: pause.requestId,
      conversationId: "room-1",
      userMessageId: pause.userMessageId,
      assistantMessageId: "a-2",
      complete: true,
    };
    expect(
      h.session.resume({
        pause: { ...pause, digest: "other" },
        reply: { ...reply, text: "x" },
      }),
    ).toBe(false);
    expect(
      h.session.resume({
        pause,
        reply: { ...reply, text: "Passport, charger and boots." },
      }),
    ).toBe(true);
    await flush();
    expect(h.log.captures).toBe(1);
    expect(h.speeches[0]?.input.text).toBe("Passport, charger and boots.");
    h.speeches[0]?.done.resolve();
    await flush();
    expect(h.log).toMatchObject({ captures: 2, closed: 1, cancelled: 0 });
    expect(h.log.reopens).toEqual([undefined, true]);
  });
});

describe("splitSpokenSentences and timing", () => {
  it("keeps the reply text and avoids tiny fragments", () => {
    expect(
      splitSpokenSentences(
        "  Dr. Smith is in. The visit is at 9:30 on Tuesday. Bring your card!  ",
      ),
    ).toEqual([
      "Dr. Smith is in. The visit is at 9:30 on Tuesday.",
      "Bring your card!",
    ]);
    expect(splitSpokenSentences("")).toEqual([]);
    const text =
      "One sentence that is long enough. Another one that is long enough? Last.";
    expect(splitSpokenSentences(text).join(" ")).toBe(text);
  });

  it("refuses a long gap shorter than the short gap", () => {
    expect(
      () =>
        new VoiceAssistantSession(
          {
            conversationId: "r",
            assertCurrent() {},
            listen: async () => ({ close: async () => {}, cancel() {} }),
            send: async () => ({}) as AssistantReply,
            speak: async () => {},
          },
          { timing: { shortGapMs: 900, longGapMs: 300 } },
        ),
    ).toThrow(RangeError);
  });
});

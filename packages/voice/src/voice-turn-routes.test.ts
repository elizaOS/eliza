import { describe, expect, it } from "vitest";
import {
  type AssistantHeard,
  type AssistantListenHandlers,
  VoiceAssistantSession,
} from "./voice-assistant-session";
import {
  createHeardReporter,
  type HeardOutcome,
  type HeardReport,
  readEndOfTurn,
  residentEndpoint,
} from "./voice-turn-routes";

// The resident's end-of-turn and heard routes as the conversation voice controller uses them.
// Fake request ports only: decision and accounting evidence, not scorer, model or device evidence.
const conversationId = "room-1";
const replyId = "11111111-1111-4111-8111-111111111111";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const failure = (status: number) =>
  Object.assign(new Error(`Local agent request failed (HTTP ${status}).`), {
    status,
    data: { error: "x" },
  });

describe("end-of-turn route", () => {
  it("finishes only on available+complete; every unavailable or malformed shape is unavailable", () => {
    expect(
      readEndOfTurn({
        available: true,
        endOfTurnProbability: 0.9,
        complete: true,
        commitThreshold: 0.7,
        latencyMs: 33.4,
      }),
    ).toEqual({ decision: "finished", latencyMs: 33 });
    expect(
      readEndOfTurn({ available: true, complete: false, latencyMs: 8 }),
    ).toEqual({ decision: "continue", latencyMs: 8 });
    expect(readEndOfTurn({ available: false, reason: "ram-pressure" })).toEqual(
      { decision: "unavailable", reason: "ram-pressure" },
    );
    expect(
      readEndOfTurn({ available: false, reason: "something new" }),
    ).toEqual({ decision: "unavailable", reason: "unknown" });
    for (const value of [
      null,
      [],
      "complete",
      { complete: true },
      { available: true },
      { available: true, complete: "yes" },
      { available: "true", complete: true },
    ])
      expect(readEndOfTurn(value).decision).toBe("unavailable");
  });

  it("posts the trimmed transcript, refuses over-long text and rejects on a scoring error", async () => {
    const calls: [string, unknown][] = [];
    const port = residentEndpoint(() => (path, body) => {
      calls.push([path, body]);
      return Promise.resolve({ available: true, complete: true, latencyMs: 2 });
    });
    expect(
      await port("  what  time is it ", new AbortController().signal),
    ).toEqual({ decision: "finished", latencyMs: 2 });
    expect(calls).toEqual([
      [
        "/api/asr/local-inference/end-of-turn",
        { transcript: "what time is it" },
      ],
    ]);
    expect(await port("a".repeat(4097), new AbortController().signal)).toEqual({
      decision: "unavailable",
      reason: "too-long",
    });
    expect(calls).toHaveLength(1);
    expect(
      await residentEndpoint(() => null)("hello", new AbortController().signal),
    ).toEqual({ decision: "unavailable", reason: "unknown" });
    await expect(
      residentEndpoint(() => () => Promise.reject(failure(502)))(
        "hello",
        new AbortController().signal,
      ),
    ).rejects.toThrow(/502/);
    const aborted = new AbortController();
    aborted.abort();
    await expect(port("hello", aborted.signal)).rejects.toBeDefined();
  });
});

type Response = number | Record<string, unknown> | undefined;
function reporter(responses: Response[], assistant = [replyId]) {
  const calls: { path: string; body: unknown }[] = [];
  const timers: number[] = [];
  const outcomes: [HeardOutcome, { attempts: number; status?: number }][] = [];
  let current = true;
  const heard = createHeardReporter({
    request: () => (path, body) => {
      calls.push({ path, body });
      const next = responses.shift();
      if (typeof next === "number") return Promise.reject(failure(next));
      return Promise.resolve(
        next ?? {
          ok: true,
          messageId: replyId,
          text: (body as { heardText: string }).heardText,
          truncated: true,
          changed: true,
        },
      );
    },
    current: (id) => current && id === conversationId,
    isAssistantReply: (id, message) =>
      id === conversationId && assistant.includes(message),
    onOutcome: (outcome, detail) => outcomes.push([outcome, detail]),
    setTimer: (callback, ms) => {
      timers.push(ms);
      callback();
    },
    retryDelayMs: 1500,
  });
  return {
    calls,
    timers,
    outcomes,
    heard,
    setCurrent(value: boolean) {
      current = value;
    },
  };
}
const interrupted = (extra: Partial<HeardReport> = {}): HeardReport => ({
  conversationId,
  replyId,
  heard: "You have two meetings today.",
  unheard: "The first one starts at nine.",
  interrupted: true,
  ...extra,
});

describe("heard route", () => {
  it("sends the exact played prefix for this conversation's reply once", async () => {
    const r = reporter([]);
    expect(await r.heard.report(interrupted())).toBe("recorded");
    expect(r.calls).toEqual([
      {
        path: `/api/conversations/room-1/messages/${replyId}/heard`,
        body: { heardText: "You have two meetings today." },
      },
    ]);
    expect(r.outcomes).toEqual([["recorded", { attempts: 1, status: 200 }]]);
    expect(await r.heard.report(interrupted())).toBe("unchanged");
    expect(r.calls).toHaveLength(1);
    const idempotent = reporter([
      {
        ok: true,
        messageId: replyId,
        text: "x",
        truncated: true,
        changed: false,
      },
    ]);
    expect(await idempotent.heard.report(interrupted())).toBe("unchanged");
  });

  it("sends nothing when the reply was fully heard, not interrupted, or nothing was heard", async () => {
    const r = reporter([]);
    expect(
      await r.heard.report(interrupted({ interrupted: false, unheard: "" })),
    ).toBe("not-needed");
    expect(await r.heard.report(interrupted({ unheard: "  " }))).toBe(
      "not-needed",
    );
    expect(
      await r.heard.report(interrupted({ heard: "", unheard: "All of it." })),
    ).toBe("nothing-heard");
    expect(r.calls).toEqual([]);
  });

  it("accepts only assistant replies of the current conversation, and nothing after the binding changed", async () => {
    const r = reporter([]);
    expect(
      await r.heard.report(interrupted({ conversationId: "room-2" })),
    ).toBe("invalid");
    expect(
      await r.heard.report(
        interrupted({ replyId: "22222222-2222-4222-8222-222222222222" }),
      ),
    ).toBe("invalid");
    expect(await r.heard.report(interrupted({ replyId: "not-a-uuid" }))).toBe(
      "invalid",
    );
    r.setCurrent(false);
    expect(await r.heard.report(interrupted())).toBe("stale");
    expect(r.calls).toEqual([]);
  });

  it("treats 409 as a conflict, retries 404 and 503 once later, and rejects 400", async () => {
    const conflict = reporter([409]);
    expect(await conflict.heard.report(interrupted())).toBe("conflict");
    expect(conflict.calls).toHaveLength(1);
    expect(conflict.timers).toEqual([]);
    const missing = reporter([404, 404]);
    expect(await missing.heard.report(interrupted())).toBe("not-found");
    expect(missing.calls).toHaveLength(2);
    expect(missing.timers).toEqual([1500]);
    expect(missing.outcomes).toEqual([
      ["not-found", { attempts: 2, status: 404 }],
    ]);
    const restarting = reporter([503]);
    expect(await restarting.heard.report(interrupted())).toBe("recorded");
    expect(restarting.calls).toHaveLength(2);
    const down = reporter([503, 503]);
    expect(await down.heard.report(interrupted())).toBe("unavailable");
    const bad = reporter([400]);
    expect(await bad.heard.report(interrupted())).toBe("rejected");
    expect(bad.calls).toHaveLength(1);
    let dropped = false;
    const late = createHeardReporter({
      request: () => () => Promise.reject(failure(404)),
      current: () => !dropped,
      isAssistantReply: () => true,
      setTimer: (callback) => {
        dropped = true;
        callback();
      },
    });
    expect(await late.report(interrupted())).toBe("stale");
  });

  it("never blocks the next turn: a barge-in reports the played sentence while the next turn is sent", async () => {
    let now = 0;
    let id = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const clock = {
      now: () => now,
      setTimer: (callback: () => void, ms: number) => {
        timers.set(++id, { at: now + ms, callback });
        return id;
      },
      clearTimer: (handle: unknown) => {
        timers.delete(handle as number);
      },
    };
    const advance = async (ms: number) => {
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
    };
    const requests: { path: string; body: unknown }[] = [];
    let release: (value: unknown) => void = () => {};
    const heardRoute = new Promise((resolve) => {
      release = resolve;
    });
    const heard = createHeardReporter({
      request: () => (path, body) => {
        requests.push({ path, body });
        return heardRoute;
      },
      current: () => true,
      isAssistantReply: (c, m) => c === conversationId && m === replyId,
    });
    const sends: string[] = [];
    const speeches: (() => void)[] = [];
    let mic: AssistantListenHandlers | undefined;
    const session = new VoiceAssistantSession(
      {
        conversationId,
        assertCurrent() {},
        listen: async (handlers) => {
          mic = handlers;
          return { fullDuplex: true, close: async () => {}, cancel() {} };
        },
        send: (input) => {
          sends.push(input.text);
          return sends.length === 1
            ? Promise.resolve({
                requestId: input.turnId,
                conversationId,
                userMessageId: "u-1",
                assistantMessageId: replyId,
                text: "You have two meetings today. The first one starts at nine.",
                complete: true,
              })
            : new Promise(() => {});
        },
        speak: (input) =>
          new Promise<void>((resolve, reject) => {
            speeches.push(resolve);
            input.onStarted();
            input.signal.addEventListener(
              "abort",
              () => reject(new DOMException("stopped", "AbortError")),
              { once: true },
            );
          }),
        onHeard: (value: AssistantHeard) => {
          void heard.report({ conversationId, ...value });
        },
      },
      { clock },
    );
    await session.start();
    const say = async (text: string) => {
      mic?.onSpeechStart(now);
      await advance(400);
      mic?.onSpeechEnd(now);
      mic?.onSegment(text);
      await flush();
    };
    await say("what is on my calendar");
    await advance(1200);
    speeches[0]?.();
    await flush();
    expect(speeches).toHaveLength(2);
    await say("and tomorrow");
    expect(requests).toEqual([
      {
        path: `/api/conversations/room-1/messages/${replyId}/heard`,
        body: { heardText: "You have two meetings today." },
      },
    ]);
    await advance(1200);
    expect(sends).toEqual(["what is on my calendar", "and tomorrow"]);
    release({
      ok: true,
      messageId: replyId,
      text: "You have two meetings today.",
      truncated: true,
      changed: true,
    });
    await session.stop();
  });
});

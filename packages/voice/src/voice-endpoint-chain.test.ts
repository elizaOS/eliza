import { describe, expect, it } from "vitest";
import {
  CLEF_ENDPOINT_UNAVAILABLE_REASONS,
  CLEF_TURN_MAX_CHARS,
  type ClefTurnClient,
  type ClefTurnRequest,
  clefEndpointStageEnabled,
  createEndpointChain,
  readClefTurn,
} from "./voice-endpoint-chain";
import { voiceTimingEndpoint } from "./voice-turn-timing";

// Stub stages and a manual timer. These are chain contracts, not Clef, scorer or latency evidence.
function manualTimers() {
  let id = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (callback: () => void) => {
      pending.set(++id, callback);
      return id;
    },
    clearTimer: (handle: unknown) => {
      pending.delete(handle as number);
    },
    fireAll() {
      for (const [key, callback] of [...pending]) {
        pending.delete(key);
        callback();
      }
    },
    get size() {
      return pending.size;
    },
  };
}
const turnOk = (
  complete: boolean,
  completeProbability = complete ? 0.9 : 0.1,
) => ({
  status: "ok",
  kind: "turn",
  model: "clef-flash",
  complete,
  completeProbability,
});
const signal = () => new AbortController().signal;

describe("createEndpointChain", () => {
  it("builds no port without a stage, and the Clef stage only with an explicit enable and a client", () => {
    const client: ClefTurnClient = async () => turnOk(true);
    expect(createEndpointChain({})).toBeUndefined();
    expect(
      createEndpointChain({ clef: { enabled: false, client } }),
    ).toBeUndefined();
    expect(
      createEndpointChain({ clef: { enabled: true, client: null } }),
    ).toBeUndefined();
    expect(
      createEndpointChain({
        clef: { enabled: "true" as unknown as boolean, client },
      }),
    ).toBeUndefined();
    expect(clefEndpointStageEnabled({ enabled: true, client })).toBe(true);
    expect(clefEndpointStageEnabled({ enabled: true, client: undefined })).toBe(
      false,
    );
    expect(createEndpointChain({ clef: { enabled: true, client } })).toBeTypeOf(
      "function",
    );
  });

  it("lets a scored local decision decide without asking Clef", async () => {
    const asked: ClefTurnRequest[] = [];
    const chain = createEndpointChain({
      local: async () => ({ decision: "continue", latencyMs: 7 }),
      clef: {
        enabled: true,
        client: async (request) => {
          asked.push(request);
          return turnOk(true);
        },
      },
    });
    expect(await chain?.("so I was thinking", signal())).toEqual({
      decision: "continue",
      latencyMs: 7,
      path: "local",
    });
    const finished = createEndpointChain({ local: async () => "finished" });
    expect(await finished?.("done", signal())).toEqual({
      decision: "finished",
      path: "local",
    });
    expect(asked).toEqual([]);
  });

  it("asks Clef with text only when the local scorer cannot score", async () => {
    const asked: ClefTurnRequest[] = [];
    let now = 100;
    const chain = createEndpointChain({
      local: async () => ({ decision: "unavailable", reason: "ram-pressure" }),
      clef: {
        enabled: true,
        client: async (request) => {
          asked.push(request);
          now += 40;
          return turnOk(true);
        },
        recentTurns: () => [
          { speaker: "assistant", text: "Which city?" },
          { speaker: "person", text: "  " },
        ],
      },
      now: () => now,
    });
    expect(await chain?.("  Lisbon,   please ", signal())).toEqual({
      decision: "finished",
      latencyMs: 40,
      path: "clef",
    });
    expect(asked).toEqual([
      {
        kind: "turn",
        transcript: "Lisbon, please",
        recentTurns: [{ speaker: "assistant", text: "Which city?" }],
      },
    ]);
    const failing = createEndpointChain({
      local: async () => {
        throw new Error("502");
      },
      clef: { enabled: true, client: async () => turnOk(false) },
    });
    expect(await failing?.("and then", signal())).toMatchObject({
      decision: "continue",
      path: "clef",
    });
  });

  it("never treats an unavailable, malformed, refused or late Clef as a yes", async () => {
    const answers: [unknown, string][] = [
      [{ status: "unavailable", reason: "disabled" }, "clef-disabled"],
      [{ status: "unavailable", reason: "provider_error" }, "clef-unavailable"],
      [
        { status: "ok", kind: "mode", suggestedMode: "tell" },
        "clef-unavailable",
      ],
      [{ status: "ok", kind: "turn", complete: "yes" }, "clef-unavailable"],
      // A probability that contradicts the verdict is not a verdict.
      [turnOk(true, 0.2), "clef-unavailable"],
      [null, "clef-unavailable"],
    ];
    for (const [answer, reason] of answers) {
      const chain = createEndpointChain({
        clef: { enabled: true, client: async () => answer },
      });
      expect(await chain?.("I am done", signal())).toEqual({
        decision: "unavailable",
        reason,
        path: "clef",
      });
    }
    const refused = createEndpointChain({
      clef: {
        enabled: true,
        client: async () => {
          throw new Error("Clef decision request was refused (401)");
        },
      },
    });
    expect(await refused?.("I am done", signal())).toEqual({
      decision: "unavailable",
      reason: "clef-error",
      path: "clef",
    });
    const timers = manualTimers();
    let aborted: AbortSignal | undefined;
    const late = createEndpointChain({
      clef: {
        enabled: true,
        timeoutMs: 250,
        client: (_request, clefSignal) => {
          aborted = clefSignal;
          return new Promise(() => {});
        },
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const pending = late?.("I am done", signal());
    await Promise.resolve();
    timers.fireAll();
    expect(await pending).toEqual({
      decision: "unavailable",
      reason: "clef-timeout",
      path: "clef",
    });
    expect(aborted?.aborted).toBe(true);
    expect(timers.size).toBe(0);
  });

  it("never sends text over Clef's limit and keeps the local answer when Clef is off", async () => {
    const asked: ClefTurnRequest[] = [];
    const chain = createEndpointChain({
      clef: {
        enabled: true,
        client: async (request) => {
          asked.push(request);
          return turnOk(true);
        },
      },
    });
    expect(
      await chain?.("x".repeat(CLEF_TURN_MAX_CHARS + 1), signal()),
    ).toEqual({
      decision: "unavailable",
      reason: "clef-too-long",
      path: "clef",
    });
    expect(asked).toEqual([]);
    const localOnly = createEndpointChain({
      local: async () => ({ decision: "unavailable", reason: "unscored" }),
      clef: { enabled: false, client: async () => turnOk(true) },
    });
    expect(await localOnly?.("done", signal())).toEqual({
      decision: "unavailable",
      reason: "unscored",
      path: "local",
    });
    // Without a later stage a failing scorer stays an error for the session to record.
    const failing = createEndpointChain({
      local: async () => {
        throw new Error("502");
      },
    });
    await expect(failing?.("done", signal())).rejects.toThrow("502");
  });

  it("stops between stages and drops Clef when speech resumes", async () => {
    const controller = new AbortController();
    const asked: ClefTurnRequest[] = [];
    const chain = createEndpointChain({
      local: async () => {
        controller.abort(new DOMException("speech resumed", "AbortError"));
        return { decision: "unavailable", reason: "unscored" };
      },
      clef: {
        enabled: true,
        client: async (request) => {
          asked.push(request);
          return turnOk(true);
        },
      },
    });
    await expect(chain?.("I am done", controller.signal)).rejects.toThrow(
      "speech resumed",
    );
    expect(asked).toEqual([]);

    const during = new AbortController();
    let clefSignal: AbortSignal | undefined;
    const timers = manualTimers();
    const inFlight = createEndpointChain({
      clef: {
        enabled: true,
        client: (_request, value) => {
          clefSignal = value;
          return new Promise((_resolve, reject) =>
            value?.addEventListener("abort", () => reject(value.reason), {
              once: true,
            }),
          );
        },
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    const pending = inFlight?.("I am done", during.signal);
    await Promise.resolve();
    during.abort(new DOMException("speech resumed", "AbortError"));
    await expect(pending).rejects.toThrow("speech resumed");
    expect(clefSignal?.aborted).toBe(true);
    expect(timers.size).toBe(0);
  });
});

describe("readClefTurn", () => {
  it("reads only an ok turn verdict", () => {
    expect(readClefTurn(turnOk(true))).toEqual({ decision: "finished" });
    expect(readClefTurn(turnOk(false))).toEqual({ decision: "continue" });
    expect(
      readClefTurn({ status: "ok", kind: "turn", complete: true }),
    ).toEqual({ decision: "finished" });
    expect(readClefTurn([turnOk(true)])).toEqual({
      decision: "unavailable",
      reason: "clef-unavailable",
    });
  });
});

describe("timing endpoint path", () => {
  it("keeps the chain path and Clef reasons, and refuses unknown paths", () => {
    // The timing allowlist lists the chain's Clef reasons itself; it must stay the same set.
    for (const reason of CLEF_ENDPOINT_UNAVAILABLE_REASONS)
      expect(
        voiceTimingEndpoint({ by: "gap", semantic: "unavailable", reason }),
      ).toEqual({ by: "gap", semantic: "unavailable", reason });
    expect(
      voiceTimingEndpoint({
        by: "semantic",
        semantic: "complete",
        latencyMs: 40,
        path: "clef",
      }),
    ).toEqual({
      by: "semantic",
      semantic: "complete",
      latencyMs: 40,
      path: "clef",
    });
    expect(
      voiceTimingEndpoint({
        by: "gap",
        semantic: "unavailable",
        reason: "clef-timeout",
        path: "clef",
      }),
    ).toEqual({
      by: "gap",
      semantic: "unavailable",
      reason: "clef-timeout",
      path: "clef",
    });
    expect(
      voiceTimingEndpoint({ by: "gap", semantic: "timeout", path: "gap" }),
    ).toBeUndefined();
    expect(voiceTimingEndpoint({ by: "gap", semantic: "timeout" })).toEqual({
      by: "gap",
      semantic: "timeout",
    });
  });
});

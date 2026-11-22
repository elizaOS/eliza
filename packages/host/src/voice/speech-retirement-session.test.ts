import { expect, test, vi } from "vitest";
import {
  createSpeechRelaySession,
  SPEECH_RELAY_SETTLE_WAIT_MS,
  type SpeechRelayCreditReservation,
  type SpeechRelayPorts,
  type SpeechRelayRetirementHandle,
} from "./speech-relay-session";
import { InMemoryVoiceUsageStore } from "./usage";

function ports() {
  let handle!: SpeechRelayRetirementHandle;
  let unknownDrain = false,
    settlementFails = 0,
    money = 0,
    window = 0,
    delivered = 0;
  const value: SpeechRelayPorts = {
    enabled: true,
    assertCurrent() {},
    consumeConsent: async () => true,
    usageStore: {
      checkAndRecord: async () => ({ allowed: true }),
      release: async () => {},
    } as never,
    usageLimits: {} as never,
    subscribeRevoked: () => () => {},
    registerRetirement: (value) => {
      handle = value;
    },
    reserveCredits: async (scope) => {
      // Later windows carry their budget window in each request ID.
      const index = window++;
      const suffix = index ? `:${index}` : "";
      return {
        supportsPerKindSettlement: true,
        beforeProviderDispatch: async () => {},
        settle: async (details, kinds = ["stt", "tts"]) => {
          if (settlementFails > 0) {
            settlementFails--;
            throw Error("settlement failed");
          }
          money++;
          // Mirrors the Cloud admission's per-kind choice.
          const basis = (kind: "stt" | "tts") =>
            details.dispatched?.[kind] === true
              ? details.accountingBasis
              : undefined;
          const stt = basis("stt"),
            tts = basis("tts");
          return {
            ...(kinds.includes("stt") && {
              stt: {
                state:
                  !stt &&
                  (details.dispatched?.stt !== true ||
                    details.outcomes?.stt === "complete")
                    ? ("actual" as const)
                    : ("conservative" as const),
                requestId: `speech:${scope.cloudSessionId}:stt${suffix}`,
                amountUsd: "0",
                terminal: true as const,
                ...(stt ? { basis: stt } : {}),
              },
            }),
            ...(kinds.includes("tts") && {
              tts: {
                state: tts ? ("conservative" as const) : ("actual" as const),
                requestId: `speech:${scope.cloudSessionId}:tts${suffix}`,
                amountUsd: "0",
                terminal: true as const,
                ...(tts ? { basis: tts } : {}),
              },
            }),
          };
        },
      };
    },
    openStt: () => ({
      sendAudioChunk(chunk) {
        delivered += chunk.byteLength;
      },
      cancel() {},
      drain: async () => {
        if (unknownDrain) throw Error("no trusted drain");
        return {
          source: "provider-graceful-close",
          audioBytes: delivered,
          sampleRate: 16000,
          channels: 1,
          encoding: "pcm_s16le",
        } as const;
      },
    }),
    openTts: () => ({ sendPhrase() {}, finish() {}, cancel() {} }),
    confirmTtsTransportStopped: async () => "transport_closed",
    emit() {},
    onClosed(result) {
      void result.catch(() => {});
    },
  };
  return {
    value,
    get handle() {
      return handle;
    },
    failDrain() {
      unknownDrain = true;
    },
    restoreDrain() {
      unknownDrain = false;
    },
    failSettlement(times = 1) {
      settlementFails = times;
    },
    get money() {
      return money;
    },
  };
}
const identity = {
  organizationId: "org",
  userId: "owner",
  cloudSessionId: "session",
};
test("paid renewal retains one STT connection and settles each window once", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const p = ports();
  const events: unknown[] = [];
  let opened = 0;
  const open = p.value.openStt;
  p.value.openStt = (...args) => {
    opened++;
    return open(...args);
  };
  p.value.maxWindows = 2;
  p.value.extend = async (_scope, expiresAt) => expiresAt;
  p.value.emit = (event) => events.push(event);
  try {
    const session = await createSpeechRelaySession(
      identity,
      "consent",
      p.value,
    );
    await vi.advanceTimersByTimeAsync(50_000);
    expect(events).toContainEqual({
      t: "extended",
      expiresAt: new Date(111_000).toISOString(),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(opened).toBe(1);
    expect(p.handle.evidence()).toBeUndefined();
    await session.close();
    expect(p.handle.evidence()).toMatchObject({
      accounting: "settled_actual",
      moneyTerminal: true,
    });
    expect(p.money).toBe(4);
    await session.close();
    expect(p.money).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});
/** An org gate that holds every unsettled kind's estimate until it settles. */
function gated(p: ReturnType<typeof ports>, windowsOfBalance: number) {
  let available = windowsOfBalance * 2,
    window = 0;
  const settled = new Map<
    string,
    Parameters<SpeechRelayCreditReservation["settle"]>[0][]
  >();
  const renewals: unknown[] = [];
  // Settlements and TTS dispatch gates a test holds open until it releases them.
  const holds = new Map<string, Promise<void>>();
  const hold = (key: string) => {
    let release!: () => void;
    holds.set(
      key,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      holds.delete(key);
      release();
    };
  };
  const reserve = p.value.reserveCredits;
  p.value.reserveCredits = async (...args) => {
    const index = window++;
    if (available < 2)
      throw Object.assign(Error("Insufficient credits"), {
        name: "InsufficientCreditsError",
        required: 2,
        available,
      });
    available -= 2;
    const reservation = await reserve(...args);
    return {
      ...reservation,
      beforeProviderDispatch: async (kind) => {
        await holds.get(`${index}:dispatch:${kind}`);
        return reservation.beforeProviderDispatch(kind);
      },
      settle: async (details, kinds = ["stt", "tts"]) => {
        for (const kind of kinds) {
          const key = `${index}:${kind}`;
          settled.set(key, [...(settled.get(key) ?? []), details]);
          await holds.get(key);
        }
        const result = await reservation.settle(details, kinds);
        available += kinds.length;
        return result;
      },
    };
  };
  p.value.extend = async (_scope, expiresAt) => expiresAt;
  p.value.onRenewal = (result) => renewals.push(result);
  return {
    settled,
    renewals,
    hold,
    get available() {
      return available;
    },
  };
}
const SUPERSEDED = {
  providerMayHaveStarted: true,
  outcome: "unknown",
  outcomes: { stt: "unknown", tts: "unknown" },
  accountingBasis: "submitted_counter_provider_unconfirmed",
} as const;
const EXTENDED = { phase: "extend", result: "extended" } as const;
test("superseded windows settle once their end passes so two holds of balance renew every window", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const p = ports();
  const gate = gated(p, 2);
  p.value.maxWindows = 4;
  try {
    const session = await createSpeechRelaySession(
      identity,
      "consent",
      p.value,
    );
    session.sendPcm(new Uint8Array(3200));
    await session.control({ t: "tts", id: "turn", text: "hello" });
    await vi.advanceTimersByTimeAsync(50_000);
    expect(gate.renewals).toEqual([EXTENDED]);
    expect(gate.settled.size).toBe(0);
    // The first window settles at its own end, 40 s before the next renewal.
    await vi.advanceTimersByTimeAsync(10_000);
    expect([...gate.settled.keys()]).toEqual(["0:stt", "0:tts"]);
    await vi.advanceTimersByTimeAsync(40_000);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(gate.renewals).toEqual([EXTENDED, EXTENDED, EXTENDED]);
    // The balance only ever held the live window and the one it reserved.
    expect(gate.available).toBe(0);
    expect([...gate.settled.keys()]).toEqual([
      "0:stt",
      "0:tts",
      "1:stt",
      "1:tts",
    ]);
    for (const kind of ["stt", "tts"]) {
      expect(gate.settled.get(`0:${kind}`)).toEqual([
        {
          ...SUPERSEDED,
          pcmBytes: 3200,
          ttsCharacters: 5,
          dispatched: { stt: true, tts: true },
        },
      ]);
      expect(gate.settled.get(`1:${kind}`)).toEqual([
        {
          ...SUPERSEDED,
          pcmBytes: 0,
          ttsCharacters: 0,
          dispatched: { stt: false, tts: false },
        },
      ]);
    }
    await session.close();
    expect([...gate.settled.keys()].sort()).toEqual(
      [0, 1, 2, 3].flatMap((index) => [`${index}:stt`, `${index}:tts`]),
    );
    for (const details of gate.settled.values())
      expect(details).toHaveLength(1);
    // The oldest held window still carries the open streams' closure.
    expect(gate.settled.get("2:stt")?.[0]).toMatchObject({
      pcmBytes: 0,
      dispatched: { stt: true },
      outcomes: { stt: "complete" },
    });
    expect(gate.settled.get("3:stt")?.[0]).toMatchObject({
      dispatched: { stt: false, tts: false },
    });
    expect(p.handle.evidence()).toMatchObject({
      stt: "gracefully_drained",
      tts: "transport_closed",
      accounting: "settled_actual",
      moneyTerminal: true,
    });
    expect(gate.available).toBe(4);
    await session.close();
    for (const details of gate.settled.values())
      expect(details).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
test("a failed superseded settlement is reported and retried with its frozen target before the next reservation", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const p = ports();
  const gate = gated(p, 2);
  p.value.maxWindows = 3;
  try {
    const session = await createSpeechRelaySession(
      identity,
      "consent",
      p.value,
    );
    session.sendPcm(new Uint8Array(3200));
    await vi.advanceTimersByTimeAsync(50_000);
    p.failSettlement();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gate.renewals).toMatchObject([
      EXTENDED,
      {
        phase: "settle",
        result: "error",
        error: { errors: [{ message: "settlement failed" }] },
      },
    ]);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(gate.renewals).toHaveLength(3);
    expect(gate.renewals[2]).toEqual(EXTENDED);
    const attempts = gate.settled.get("0:stt");
    expect(attempts).toHaveLength(2);
    expect(attempts?.[1]).toBe(attempts?.[0]);
    expect(attempts?.[0]).toEqual({
      ...SUPERSEDED,
      pcmBytes: 3200,
      ttsCharacters: 0,
      dispatched: { stt: true, tts: false },
    });
    expect(gate.settled.get("0:tts")).toHaveLength(1);
    await session.close();
    expect(gate.settled.get("0:stt")).toHaveLength(2);
    for (const key of ["0:tts", "1:stt", "1:tts", "2:stt", "2:tts"])
      expect(gate.settled.get(key)).toHaveLength(1);
    expect(p.handle.evidence()).toMatchObject({
      accounting: "settled_actual",
      moneyTerminal: true,
    });
  } finally {
    vi.useRealTimers();
  }
});
test("an unsettled superseded window refuses renewal at the current end and close retries its frozen target", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const p = ports();
  const gate = gated(p, 2);
  p.value.maxWindows = 4;
  try {
    const session = await createSpeechRelaySession(
      identity,
      "consent",
      p.value,
    );
    session.sendPcm(new Uint8Array(3200));
    await vi.advanceTimersByTimeAsync(50_000);
    // Both kinds of the first window fail when it ends and again when the
    // next renewal retries them, so that renewal finds no headroom.
    p.failSettlement(4);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(gate.renewals).toMatchObject([
      EXTENDED,
      { phase: "settle", result: "error" },
      { phase: "settle", result: "error" },
      {
        phase: "reserve",
        result: "error",
        error: { name: "InsufficientCreditsError", required: 2, available: 0 },
      },
    ]);
    // The refusal leaves the second window's end in force.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(p.handle.evidence()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await session.close();
    for (const kind of ["stt", "tts"]) {
      const attempts = gate.settled.get(`0:${kind}`);
      expect(attempts).toHaveLength(3);
      for (const attempt of attempts ?? []) expect(attempt).toBe(attempts?.[0]);
    }
    expect(gate.settled.get("0:stt")?.[0]).toEqual({
      ...SUPERSEDED,
      pcmBytes: 3200,
      ttsCharacters: 0,
      dispatched: { stt: true, tts: false },
    });
    expect(gate.settled.get("1:stt")?.[0]).toMatchObject({
      pcmBytes: 0,
      dispatched: { stt: true },
      outcomes: { stt: "complete" },
    });
    expect([...gate.settled.keys()].sort()).toEqual([
      "0:stt",
      "0:tts",
      "1:stt",
      "1:tts",
    ]);
    expect(p.handle.evidence()).toMatchObject({
      accounting: "settled_actual",
      moneyTerminal: true,
    });
  } finally {
    vi.useRealTimers();
  }
});
test("a slow superseded settlement neither holds renewal past its bound nor escapes close", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const p = ports();
  const gate = gated(p, 3);
  p.value.maxWindows = 3;
  const release = gate.hold("0:stt");
  try {
    const session = await createSpeechRelaySession(
      identity,
      "consent",
      p.value,
    );
    session.sendPcm(new Uint8Array(3200));
    await vi.advanceTimersByTimeAsync(100_000);
    expect(gate.settled.get("0:stt")).toHaveLength(1);
    expect(gate.renewals).toEqual([EXTENDED]);
    await vi.advanceTimersByTimeAsync(SPEECH_RELAY_SETTLE_WAIT_MS);
    expect(gate.renewals).toEqual([EXTENDED, EXTENDED]);
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    expect(p.handle.evidence()).toBeUndefined();
    release();
    await closing;
    expect(p.handle.evidence()).toMatchObject({
      accounting: "settled_actual",
      moneyTerminal: true,
    });
    // Close joined the attempt in flight instead of starting another.
    expect([...gate.settled.keys()].sort()).toEqual(
      [0, 1, 2].flatMap((index) => [`${index}:stt`, `${index}:tts`]),
    );
    for (const details of gate.settled.values())
      expect(details).toHaveLength(1);
  } finally {
    release();
    vi.useRealTimers();
  }
});
test.each(["pcm", "tts"] as const)(
  "after a quiet window settles, %s beyond the held window's budget retires the session",
  async (kind) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const p = ports();
    const gate = gated(p, 3);
    p.value.maxWindows = 3;
    try {
      const session = await createSpeechRelaySession(
        identity,
        "consent",
        p.value,
      );
      await vi.advanceTimersByTimeAsync(99_000);
      expect(gate.renewals).toEqual([EXTENDED]);
      expect(gate.settled.get("0:tts")?.[0]).toMatchObject({
        pcmBytes: 0,
        ttsCharacters: 0,
      });
      // Only the live second window's budget remains; the quiet first
      // window's unused budget was released with its hold.
      if (kind === "pcm") {
        for (let n = 0; n < 600; n++) session.sendPcm(new Uint8Array(3200));
        expect(() => session.sendPcm(new Uint8Array(3200))).toThrow(
          "exceeds the admitted format or rate",
        );
      } else {
        for (let n = 0; n < 4; n++)
          await session.control({
            t: "tts",
            id: "turn",
            text: "a".repeat(1024),
          });
        await expect(
          session.control({ t: "tts", id: "turn", text: "a" }),
        ).rejects.toThrow("exceeds the admitted budget");
      }
      await session.close();
      expect(p.handle.evidence()).toMatchObject({
        accounting: "settled_actual",
        moneyTerminal: true,
      });
      expect(gate.settled.get("1:stt")?.[0]).toMatchObject(
        kind === "pcm" ? { pcmBytes: 1_920_000 } : { ttsCharacters: 4096 },
      );
    } finally {
      vi.useRealTimers();
    }
  },
);
test.each(["dispatched", "cancelled"] as const)(
  "text in flight when a window ends is frozen by the next renewal once %s",
  async (outcome) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const p = ports();
    const gate = gated(p, 2);
    p.value.maxWindows = 3;
    try {
      const session = await createSpeechRelaySession(
        identity,
        "consent",
        p.value,
      );
      await vi.advanceTimersByTimeAsync(50_000);
      // TTS dispatch waits on the live second window's reservation.
      const release = gate.hold("1:dispatch:tts");
      const sending = session.control({ t: "tts", id: "turn", text: "hello" });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(gate.settled.size).toBe(0);
      if (outcome === "cancelled")
        await session.control({ t: "cancel", id: "turn" });
      release();
      await sending;
      expect(gate.settled.size).toBe(0);
      await vi.advanceTimersByTimeAsync(40_000);
      expect(gate.renewals).toEqual([EXTENDED, EXTENDED]);
      const dispatched = outcome === "dispatched";
      for (const kind of ["stt", "tts"])
        expect(gate.settled.get(`0:${kind}`)).toEqual([
          {
            ...SUPERSEDED,
            pcmBytes: 0,
            ttsCharacters: dispatched ? 5 : 0,
            dispatched: { stt: false, tts: dispatched },
          },
        ]);
      await session.close();
      expect(p.handle.evidence()).toMatchObject({
        accounting: "settled_actual",
        moneyTerminal: true,
      });
    } finally {
      vi.useRealTimers();
    }
  },
);
test.each(["transport_closed", "not_dispatched"] as const)(
  "superseded TTS counters confirm once an unknown TTS transport later reports %s",
  async (stopped) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const p = ports();
    const gate = gated(p, 2);
    p.value.maxWindows = 2;
    try {
      const session = await createSpeechRelaySession(
        identity,
        "consent",
        p.value,
      );
      await session.control({ t: "tts", id: "turn", text: "hello" });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(gate.settled.get("0:tts")?.[0]).toMatchObject({
        ttsCharacters: 5,
        accountingBasis: "submitted_counter_provider_unconfirmed",
      });
      p.value.confirmTtsTransportStopped = async () => "unknown";
      await expect(session.close()).rejects.toThrow(
        "cleanup was not confirmed",
      );
      expect(gate.settled.has("1:tts")).toBe(false);
      await p.handle.finalizeUnknownTtsAccounting?.();
      expect(gate.settled.get("1:tts")).toMatchObject([
        {
          ttsCharacters: 0,
          accountingBasis: "submitted_counter_provider_unconfirmed",
        },
      ]);
      expect(p.handle.evidence()).toMatchObject({
        tts: "unknown",
        accounting: "unknown",
      });
      p.value.confirmTtsTransportStopped = async () => stopped;
      await p.handle.retryRetirement();
      expect(p.handle.evidence()).toMatchObject({
        tts: stopped,
        accounting: "settled_actual",
        moneyTerminal: true,
      });
      for (const details of gate.settled.values())
        expect(details).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  },
);
test.each(["quota", "admission", "extension"] as const)(
  "Stop requests provider teardown while renewal waits on %s",
  async (pending) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const p = ports();
    const stopped: string[] = [];
    const settled = new Map<
      string,
      Parameters<SpeechRelayCreditReservation["settle"]>[0][]
    >();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false,
      quotaCalls = 0,
      window = 0,
      releases = 0;
    const wait = async () => {
      entered = true;
      await held;
    };
    const quota = p.value.usageStore.checkAndRecord.bind(p.value.usageStore);
    p.value.usageStore.checkAndRecord = async (...args) => {
      if (quotaCalls++ === 1 && pending === "quota") await wait();
      return quota(...args);
    };
    p.value.usageStore.release = async () => {
      releases++;
    };
    const reserve = p.value.reserveCredits;
    p.value.reserveCredits = async (...args) => {
      const index = window++;
      if (index === 1 && pending === "admission") await wait();
      const reservation = await reserve(...args);
      return {
        ...reservation,
        settle: async (details, kinds = ["stt", "tts"]) => {
          for (const kind of kinds) {
            const key = `${index}:${kind}`;
            settled.set(key, [...(settled.get(key) ?? []), details]);
          }
          return reservation.settle(details, kinds);
        },
      };
    };
    const openStt = p.value.openStt;
    p.value.openStt = (...args) => {
      const provider = openStt(...args);
      const drain = provider.drain;
      if (!drain) throw Error("Expected a drain-capable provider");
      return {
        ...provider,
        drain: async (timeoutMs) => {
          stopped.push("stt");
          return drain(timeoutMs);
        },
      };
    };
    const openTts = p.value.openTts;
    p.value.openTts = (...args) => {
      const provider = openTts(...args);
      return {
        ...provider,
        cancel: (reason) => {
          stopped.push("tts-context");
          provider.cancel(reason);
        },
      };
    };
    p.value.confirmTtsTransportStopped = async () => {
      stopped.push("tts-transport");
      return "transport_closed";
    };
    p.value.maxWindows = 2;
    p.value.extend = async (_scope, expiresAt) => {
      if (pending === "extension") await wait();
      return expiresAt;
    };
    let session:
      | Awaited<ReturnType<typeof createSpeechRelaySession>>
      | undefined;
    try {
      session = await createSpeechRelaySession(identity, "consent", p.value);
      await session.control({ t: "tts", id: "active", text: "hello" });
      await vi.advanceTimersByTimeAsync(50_000);
      expect(entered).toBe(true);
      await session.control({ t: "stop" });
      let closed = false;
      const closing = session.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped.toSorted()).toEqual([
        "stt",
        "tts-context",
        "tts-transport",
      ]);
      expect(closed).toBe(false);
      expect(p.handle.evidence()).toBeUndefined();
      expect(settled.size).toBe(0);
      expect(releases).toBe(0);
      expect(() => session?.sendPcm(new Uint8Array(3200))).toThrow("closed");
      release();
      await closing;
      expect(p.handle.evidence()).toMatchObject({
        accounting: "settled_actual",
        moneyTerminal: true,
      });
      expect([...settled.keys()].sort()).toEqual(
        pending === "quota"
          ? ["0:stt", "0:tts"]
          : ["0:stt", "0:tts", "1:stt", "1:tts"],
      );
      for (const details of settled.values()) expect(details).toHaveLength(1);
      for (const kind of ["stt", "tts"])
        if (pending !== "quota")
          expect(settled.get(`1:${kind}`)).toEqual([
            {
              pcmBytes: 0,
              ttsCharacters: 0,
              providerMayHaveStarted: false,
              dispatched: { stt: false, tts: false },
            },
          ]);
      expect(releases).toBe(1);
      await session.close();
      expect(stopped).toHaveLength(3);
      for (const details of settled.values()) expect(details).toHaveLength(1);
      expect(releases).toBe(1);
    } finally {
      release();
      await session?.close().catch(() => {});
      vi.useRealTimers();
    }
  },
);
test.each(["credit", "quota", "legacy"] as const)(
  "failed late renewal %s cleanup remains owned",
  async (failure) => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const p = ports();
    const settled = new Map<
      string,
      Parameters<SpeechRelayCreditReservation["settle"]>[0][]
    >();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false,
      window = 0,
      releases = 0,
      failCredit = failure !== "quota";
    p.value.usageStore.release = async () => {
      releases++;
      if (failure === "quota") throw Error("quota acknowledgement lost");
    };
    const reserve = p.value.reserveCredits;
    p.value.reserveCredits = async (...args) => {
      const index = window++;
      if (index === 1) {
        entered = true;
        await held;
      }
      const reservation = await reserve(...args);
      return {
        ...reservation,
        supportsPerKindSettlement:
          index === 1 && failure === "legacy"
            ? undefined
            : reservation.supportsPerKindSettlement,
        settle: async (details, kinds = ["stt", "tts"]) => {
          for (const kind of kinds) {
            const key = `${index}:${kind}`;
            settled.set(key, [...(settled.get(key) ?? []), details]);
          }
          if (index === 1 && kinds.includes("stt") && failCredit) {
            failCredit = false;
            throw Error("zero settlement acknowledgement lost");
          }
          return reservation.settle(details, kinds);
        },
      };
    };
    p.value.maxWindows = 2;
    p.value.extend = async (_scope, expiresAt) => expiresAt;
    let session:
      | Awaited<ReturnType<typeof createSpeechRelaySession>>
      | undefined;
    try {
      session = await createSpeechRelaySession(identity, "consent", p.value);
      await vi.advanceTimersByTimeAsync(50_000);
      expect(entered).toBe(true);
      const closing = session.close();
      expect(p.handle.evidence()).toBeUndefined();
      release();
      if (failure !== "quota") {
        await expect(closing).rejects.toThrow("cleanup was not confirmed");
        expect(p.handle.evidence()?.accounting).toBe("unknown");
        expect(p.handle.evidence()?.moneyTerminal).toBeUndefined();
        if (failure === "credit") {
          await p.handle.retryRetirement();
          expect(p.handle.evidence()?.accounting).toBe("settled_actual");
          const attempts = settled.get("1:stt");
          expect(attempts).toHaveLength(2);
          expect(attempts?.[1]).toBe(attempts?.[0]);
        } else {
          await expect(p.handle.retryRetirement()).rejects.toThrow(
            "cleanup was not confirmed",
          );
          expect(settled.get("1:stt")).toHaveLength(1);
        }
      } else {
        await closing;
        expect(p.handle.evidence()?.quotaRelease).toBe("unknown");
        expect(p.handle.evidence()?.moneyTerminal).toBe(true);
        await p.handle.retryRetirement();
        expect(p.handle.evidence()?.quotaRelease).toBe("unknown");
        expect(settled.get("1:stt")).toHaveLength(1);
      }
      expect(settled.get("1:stt")?.[0]).toEqual({
        pcmBytes: 0,
        ttsCharacters: 0,
        providerMayHaveStarted: false,
        dispatched: { stt: false, tts: false },
      });
      expect(settled.get("1:tts")).toHaveLength(1);
      expect(settled.get("0:stt")).toHaveLength(1);
      expect(settled.get("0:tts")).toHaveLength(1);
      expect(p.money).toBe(failure === "legacy" ? 2 : 4);
      expect(releases).toBe(1);
    } finally {
      release();
      await session?.close().catch(() => {});
      vi.useRealTimers();
    }
  },
);
test("trusted STT drain and actual settlement yield explicit evidence", async () => {
  const p = ports();
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.close();
  expect(p.handle.evidence()).toEqual({
    stt: "gracefully_drained",
    tts: "not_dispatched",
    accounting: "settled_actual",
    moneyTerminal: true,
  });
  // A legacy fixture's bare kind IDs are NOT the identity-bound private credit contract.
  const mismatched = ports(),
    reserve = mismatched.value.reserveCredits;
  mismatched.value.reserveCredits = async (...args) => {
    const admission = await reserve(...args);
    return {
      ...admission,
      settle: async (details, kinds) => {
        const result = await admission.settle(details, kinds);
        if (result?.stt) result.stt.requestId = "stt";
        if (result?.tts) result.tts.requestId = "tts";
        return result;
      },
    };
  };
  const other = await createSpeechRelaySession(
    identity,
    "consent",
    mismatched.value,
  );
  await other.close();
  expect(mismatched.handle.evidence()?.accounting).toBe("unknown");
  expect(mismatched.handle.evidence()?.moneyTerminal).toBeUndefined();
});
test("unknown drain remains unknown even when conservative settlement completes", async () => {
  const p = ports();
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  p.failDrain();
  await expect(session.close()).rejects.toThrow();
  expect(p.handle.evidence()).toMatchObject({
    stt: "unknown",
    accounting: "unknown",
  });
});
test("settlement failure is explicit and only an explicit retry reattempts it", async () => {
  const p = ports();
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  p.failSettlement();
  const first = session.close();
  await expect(first).rejects.toThrow();
  expect(session.close()).toBe(first);
  await p.handle.retryRetirement();
  expect(p.handle.evidence()?.accounting).toBe("settled_actual");
});
test("shutdown waits pending credit admission and settles undispatched work", async () => {
  const p = ports();
  const original = p.value.reserveCredits;
  let resolve!: () => void, started!: () => void;
  const entered = new Promise<void>((yes) => {
    started = yes;
  });
  const wait = new Promise<void>((yes) => {
    resolve = yes;
  });
  p.value.reserveCredits = async (...args) => {
    started();
    await wait;
    return original(...args);
  };
  const opening = createSpeechRelaySession(identity, "consent", p.value);
  void opening.catch(() => {});
  await entered;
  let closed = false;
  const closure = p.handle.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  resolve();
  await opening.catch(() => {});
  await closure;
  expect(p.money).toBe(2);
  expect(p.handle.evidence()?.stt).toBe("not_dispatched");
});
test("TTS context completion without transport confirmation is not proof", async () => {
  const p = ports();
  p.value.confirmTtsTransportStopped = async () => "unknown";
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" });
  await expect(session.close()).rejects.toThrow("not confirmed");
  expect(p.handle.evidence()?.tts).toBe("unknown");
  expect(p.handle.evidence()?.accounting).toBe("unknown");
  expect(p.money).toBe(1);
  p.value.confirmTtsTransportStopped = async () => "transport_closed";
  await p.handle.retryRetirement();
  expect(p.handle.evidence()?.tts).toBe("transport_closed");
  expect(p.money).toBe(2);
});
test("shutdown waits pending quota and does not dispatch a provider", async () => {
  const p = ports();
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((yes) => {
      release = yes;
    }),
    started = new Promise<void>((yes) => {
      entered = yes;
    });
  p.value.usageStore.checkAndRecord = (async () => {
    entered();
    await wait;
    return { allowed: true };
  }) as never;
  const opening = createSpeechRelaySession(identity, "consent", p.value);
  void opening.catch(() => {});
  await started;
  const closing = p.handle.close();
  release();
  await opening.catch(() => {});
  await closing;
  expect(p.money).toBe(0);
  expect(p.handle.evidence()?.stt).toBe("not_dispatched");
});

test("confirmed never-bound TTS cancels queued text at zero cost", async () => {
  const p = ports();
  p.value.confirmTtsTransportStopped = async () => "not_dispatched";
  const reserve = p.value.reserveCredits;
  let settled:
    | Parameters<SpeechRelayCreditReservation["settle"]>[0]
    | undefined;
  p.value.reserveCredits = async (...args) => {
    const value = await reserve(...args);
    return {
      ...value,
      settle: async (details) => {
        settled = details;
        return value.settle(details);
      },
    };
  };
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "tts", id: "queued", text: "hello" });
  await session.close();
  expect(settled.ttsCharacters).toBe(0);
  expect(settled.dispatched.tts).toBe(false);
  expect(p.handle.evidence()?.tts).toBe("not_dispatched");
});

test("a concurrent retry joins the first pending retirement", async () => {
  const p = ports();
  let release!: () => void,
    closes = 0;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  p.value.confirmTtsTransportStopped = async () => {
    closes++;
    await waiting;
    return "transport_closed";
  };
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "pending" });
  const first = session.close();
  const retry = p.handle.retryRetirement();
  expect(retry).toBe(first);
  release();
  await first;
  expect(closes).toBe(1);
  expect(p.money).toBe(2);
});

test("ambiguous quota release is not repeated by a cleanup retry", async () => {
  const p = ports();
  let releases = 0;
  p.value.reserveCredits = async () => {
    throw Error("admission refused");
  };
  p.value.usageStore.release = (async () => {
    releases++;
    throw Error("quota release ack lost");
  }) as never;
  await expect(
    createSpeechRelaySession(identity, "consent", p.value),
  ).rejects.toThrow();
  await expect(p.handle.retryRetirement()).rejects.toThrow();
  expect(releases).toBe(1);
});

test("a successful quota release is not repeated after another cleanup failure", async () => {
  const p = ports();
  let releases = 0,
    enter!: () => void,
    release!: () => void;
  const entered = new Promise<void>((yes) => {
    enter = yes;
  });
  const waiting = new Promise<void>((yes) => {
    release = yes;
  });
  const reserve = p.value.reserveCredits;
  p.value.reserveCredits = async (...args) => {
    enter();
    await waiting;
    return reserve(...args);
  };
  p.value.usageStore.release = (async () => {
    releases++;
  }) as never;
  const opening = createSpeechRelaySession(identity, "consent", p.value);
  void opening.catch(() => {});
  await entered;
  p.failSettlement();
  const closing = p.handle.close();
  release();
  await opening.catch(() => {});
  await closing.catch(() => {});
  expect(releases).toBe(1);
  await p.handle.retryRetirement();
  expect(releases).toBe(1);
});

test("late STT evidence retains its conservative charge while TTS settles once", async () => {
  const p = ports();
  p.failDrain();
  p.value.confirmTtsTransportStopped = async () => "unknown";
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" });
  await expect(session.close()).rejects.toThrow();
  expect(p.money).toBe(1);
  p.restoreDrain();
  p.value.confirmTtsTransportStopped = async () => "transport_closed";
  await p.handle.retryRetirement();
  expect(p.money).toBe(2);
  expect(p.handle.evidence()?.accounting).toBe("unknown");
});

test("a lost settlement acknowledgement retries the original per-kind evidence", async () => {
  const p = ports();
  p.failDrain();
  p.value.confirmTtsTransportStopped = async () => "unknown";
  const reserve = p.value.reserveCredits;
  const sttInputs: string[] = [];
  let first = true;
  p.value.reserveCredits = async (...args) => {
    const admission = await reserve(...args);
    return {
      ...admission,
      settle: async (details, kinds) => {
        if (kinds?.includes("stt")) {
          sttInputs.push(details.outcomes?.stt ?? "missing");
          if (first) {
            first = false;
            throw Error("settlement acknowledgement lost");
          }
        }
        return admission.settle(details, kinds);
      },
    };
  };
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" });
  await expect(session.close()).rejects.toThrow();
  p.restoreDrain();
  p.value.confirmTtsTransportStopped = async () => "transport_closed";
  await p.handle.retryRetirement();
  expect(sttInputs).toEqual(["unknown", "unknown"]);
  expect(p.handle.evidence()?.accounting).toBe("unknown");
});

test("final bounded retry settles the frozen submitted counter but leaves provider unknown", async () => {
  const p = ports();
  p.value.confirmTtsTransportStopped = async () => "unknown";
  const reserve = p.value.reserveCredits;
  const ttsInputs: unknown[] = [];
  p.value.reserveCredits = async (...args) => {
    const admission = await reserve(...args);
    return {
      ...admission,
      settle: async (details, kinds) => {
        if (kinds?.includes("tts")) ttsInputs.push(details);
        return admission.settle(details, kinds);
      },
    };
  };
  const session = await createSpeechRelaySession(identity, "consent", p.value);
  await session.control({ t: "prepare", id: "context" });
  await expect(session.close()).rejects.toThrow();
  expect(ttsInputs).toHaveLength(0);
  const finalize = p.handle.finalizeUnknownTtsAccounting;
  if (!finalize) throw Error("Expected a retirement finalizer");
  await finalize();
  expect(ttsInputs).toMatchObject([
    {
      ttsCharacters: 0,
      accountingBasis: "submitted_counter_provider_unconfirmed",
    },
  ]);
  expect(p.handle.evidence()).toMatchObject({
    tts: "unknown",
    accounting: "unknown",
  });
  await finalize();
  expect(ttsInputs).toHaveLength(1);
});

for (const releaseCommitted of [false, true]) {
  test(`unknown quota acknowledgement preserves separate provider/money proof, committed=${releaseCommitted}`, async () => {
    const p = ports();
    const store = new InMemoryVoiceUsageStore();
    const release = store.release.bind(store);
    let releases = 0,
      enter!: () => void,
      finish!: () => void;
    const entered = new Promise<void>((yes) => {
        enter = yes;
      }),
      held = new Promise<void>((yes) => {
        finish = yes;
      });
    store.release = async (...args) => {
      releases++;
      if (releaseCommitted) await release(...args);
      throw Error("quota acknowledgement lost");
    };
    p.value.usageStore = store;
    p.value.usageLimits = { organizationDailyMinutes: 1, userDailyMinutes: 1 };
    const reserve = p.value.reserveCredits;
    p.value.reserveCredits = async (...args) => {
      enter();
      await held;
      return reserve(...args);
    };
    const opening = createSpeechRelaySession(identity, "consent", p.value);
    void opening.catch(() => {});
    await entered;
    const closing = p.handle.close();
    finish();
    await opening.catch(() => {});
    await closing;
    expect(p.handle.evidence()).toMatchObject({
      stt: "not_dispatched",
      tts: "not_dispatched",
      accounting: "settled_actual",
      moneyTerminal: true,
      quotaRelease: "unknown",
    });
    const next = await store.checkAndRecord(identity, 1, p.value.usageLimits);
    expect(next.allowed).toBe(releaseCommitted);
    await p.handle.retryRetirement();
    expect(releases).toBe(1);
    expect(p.money).toBe(2);
    expect(
      (await store.checkAndRecord(identity, 1, p.value.usageLimits)).allowed,
    ).toBe(false);
  });
}

for (const failedKind of ["stt", "tts"] as const) {
  test(`late unused ${failedKind} settlement stays owned across retirement retry`, async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const p = ports();
    const reserve = p.value.reserveCredits;
    let index = 0;
    let release!: () => void;
    let failure = true;
    const attempts = { stt: 0, tts: 0 };
    p.value.maxWindows = 2;
    p.value.extend = async (_scope, end) => end;
    p.value.reserveCredits = async (...args) => {
      const window = index++;
      if (window === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const reservation = await reserve(...args);
      return {
        ...reservation,
        settle: async (details, kinds = ["stt", "tts"]) => {
          if (window === 1) {
            expect(details).toMatchObject({
              pcmBytes: 0,
              ttsCharacters: 0,
              dispatched: { stt: false, tts: false },
            });
            for (const kind of kinds) attempts[kind]++;
            if (failure && kinds.includes(failedKind))
              throw Error("Lost settlement reply");
          }
          return reservation.settle(details, kinds);
        },
      };
    };
    try {
      const session = await createSpeechRelaySession(
        identity,
        "consent",
        p.value,
      );
      await vi.advanceTimersByTimeAsync(50_000);
      const closing = session.close();
      release();
      await expect(closing).rejects.toThrow("cleanup was not confirmed");
      expect(p.handle.evidence()?.moneyTerminal).not.toBe(true);
      const completedStt = attempts.stt;
      failure = false;
      await p.handle.retryRetirement();
      expect(p.handle.evidence()).toMatchObject({
        accounting: "settled_actual",
        moneyTerminal: true,
      });
      if (failedKind === "tts") expect(attempts.stt).toBe(completedStt);
      const completed = { ...attempts };
      await p.handle.retryRetirement();
      expect(attempts).toEqual(completed);
    } finally {
      vi.useRealTimers();
    }
  });
}

test("a lost unused-quota reply stays unknown and is never replayed", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const p = ports();
  let released = 0;
  p.value.maxWindows = 2;
  p.value.extend = async () => 0;
  p.value.usageStore.release = async () => {
    released++;
    throw Error("Reply lost after quota release");
  };
  try {
    const session = await createSpeechRelaySession(
      identity,
      "consent",
      p.value,
    );
    await vi.advanceTimersByTimeAsync(50_000);
    await session.close();
    expect(p.handle.evidence()).toMatchObject({
      moneyTerminal: true,
      quotaRelease: "unknown",
    });
    await p.handle.retryRetirement();
    expect(released).toBe(1);
    expect(p.handle.evidence()?.quotaRelease).toBe("unknown");
  } finally {
    vi.useRealTimers();
  }
});

test("a nonzero unused settlement proof cannot confirm retirement", async () => {
  for (const perKind of [true, false]) {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const p = ports();
    const reserve = p.value.reserveCredits;
    let index = 0;
    p.value.maxWindows = 2;
    p.value.extend = async () => 0;
    p.value.reserveCredits = async (...args) => {
      const window = index++;
      const reservation = await reserve(...args);
      return {
        ...reservation,
        supportsPerKindSettlement:
          window === 0 || perKind
            ? reservation.supportsPerKindSettlement
            : undefined,
        settle: async (details, kinds) => {
          const result = await reservation.settle(details, kinds);
          for (const kind of ["stt", "tts"] as const)
            if (result?.[kind] && window) result[kind].amountUsd = "1";
          return result;
        },
      };
    };
    try {
      const session = await createSpeechRelaySession(
        identity,
        "consent",
        p.value,
      );
      await vi.advanceTimersByTimeAsync(50_000);
      await expect(session.close()).rejects.toThrow(
        "cleanup was not confirmed",
      );
      expect(p.handle.evidence()?.moneyTerminal).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }
});

test("close retries a transient unused settlement once and keeps its zero target", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const p = ports();
  const reserve = p.value.reserveCredits;
  let index = 0;
  const attempts = { stt: 0, tts: 0 };
  p.value.maxWindows = 2;
  p.value.extend = async () => 0;
  p.value.reserveCredits = async (...args) => {
    const window = index++;
    const reservation = await reserve(...args);
    return {
      ...reservation,
      settle: async (details, kinds = ["stt", "tts"]) => {
        if (window) {
          expect(details).toMatchObject({
            pcmBytes: 0,
            ttsCharacters: 0,
            dispatched: { stt: false, tts: false },
          });
          for (const kind of kinds) attempts[kind]++;
          if (kinds.includes("stt") && attempts.stt === 1)
            throw Error("Temporary transport failure");
        }
        return reservation.settle(details, kinds);
      },
    };
  };
  try {
    const session = await createSpeechRelaySession(
      identity,
      "consent",
      p.value,
    );
    await vi.advanceTimersByTimeAsync(50_000);
    await session.close();
    expect(attempts).toEqual({ stt: 2, tts: 1 });
    expect(p.handle.evidence()).toMatchObject({
      moneyTerminal: true,
      accounting: "settled_actual",
    });
    await p.handle.retryRetirement();
    expect(attempts).toEqual({ stt: 2, tts: 1 });
  } finally {
    vi.useRealTimers();
  }
});

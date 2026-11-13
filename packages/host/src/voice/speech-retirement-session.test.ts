import { expect, test, vi } from "vitest";
import {
  createSpeechRelaySession,
  type SpeechRelayCreditReservation,
  type SpeechRelayPorts,
  type SpeechRelayRetirementHandle,
} from "./speech-relay-session";
import { InMemoryVoiceUsageStore } from "./usage";

function ports() {
  let handle!: SpeechRelayRetirementHandle;
  let unknownDrain = false,
    settlementFails = false,
    money = 0;
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
    reserveCredits: async (scope) => ({
      supportsPerKindSettlement: true,
      beforeProviderDispatch: async () => {},
      settle: async (details, kinds = ["stt", "tts"]) => {
        if (settlementFails) {
          settlementFails = false;
          throw Error("settlement failed");
        }
        money++;
        return {
          ...(kinds.includes("stt") && {
            stt: {
              state:
                details.dispatched?.stt !== true ||
                details.outcomes?.stt === "complete"
                  ? ("actual" as const)
                  : ("conservative" as const),
              requestId: `speech:${scope.cloudSessionId}:stt`,
              amountUsd: "0",
              terminal: true as const,
            },
          }),
          ...(kinds.includes("tts") && {
            tts: {
              state: details.ttsAccountingBasis
                ? ("conservative" as const)
                : ("actual" as const),
              requestId: `speech:${scope.cloudSessionId}:tts`,
              amountUsd: "0",
              terminal: true as const,
              ...(details.ttsAccountingBasis
                ? { basis: details.ttsAccountingBasis }
                : {}),
            },
          }),
        };
      },
    }),
    openStt: () => ({
      sendAudioChunk() {},
      cancel() {},
      drain: async () => {
        if (unknownDrain) throw Error("no trusted drain");
        return {
          source: "provider-graceful-close",
          audioBytes: 0,
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
    failSettlement() {
      settlementFails = true;
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
  const original = p.value.reserveCredits;
  let window = 0,
    opened = 0;
  const open = p.value.openStt;
  p.value.openStt = (...args) => {
    opened++;
    return open(...args);
  };
  p.value.reserveCredits = async (...args) => {
    const index = window++;
    const admission = await original(...args);
    return {
      ...admission,
      settle: async (details, kinds) => {
        const result = await admission.settle(details, kinds);
        for (const kind of ["stt", "tts"] as const)
          if (result?.[kind])
            result[kind].requestId += index ? `:${index}` : "";
        return result;
      },
    };
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
          const result = await reservation.settle(details, kinds);
          for (const kind of kinds)
            if (result?.[kind])
              result[kind].requestId += index ? `:${index}` : "";
          return result;
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
          const result = await reservation.settle(details, kinds);
          for (const kind of kinds)
            if (result?.[kind])
              result[kind].requestId += index ? `:${index}` : "";
          return result;
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
      ttsAccountingBasis: "submitted_counter_provider_unconfirmed",
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

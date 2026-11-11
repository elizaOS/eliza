import { beforeEach, expect, mock, test } from "bun:test";
import type {
  SpeechRelayPorts,
  SpeechRelayRetirementHandle,
} from "@elizaos/host/voice/speech-relay-session";
import type { reserveSpeechRelayAdmission } from "./speech-relay-admission";
import type { SpeechLifecycleRecord } from "./speech-retirement-state";

const control = {
  ttsUnknown: false,
  finalized: 0,
  afterClose: undefined as (() => void) | undefined,
  closeFails: false,
  opens: 0,
  closes: 0,
  wait: undefined as Promise<void> | undefined,
  subscriptionWait: undefined as Promise<void> | undefined,
  subscribed: 0,
  unsubscribed: 0,
  adapterCloses: 0,
  finalizerFailure: undefined as Error | undefined,
};
mock.module("@elizaos/cloud-shared/db/client", () => ({
  runWithDbCacheAsync: (fn: () => unknown) => fn(),
}));
mock.module("@elizaos/cloud-shared/lib/runtime/cloud-bindings", () => ({
  getCloudAwareEnv: () => ({}),
  runWithCloudBindingsAsync: (_env: unknown, fn: () => unknown) => fn(),
}));
mock.module("@elizaos/cloud-shared/lib/services/credits", () => ({
  InsufficientCreditsError: class extends Error {},
}));
mock.module("@elizaos/cloud-shared/lib/services/voice-usage-meter", () => ({
  createDurableVoiceUsageStore: () => ({}),
}));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { info() {}, error() {} },
}));
mock.module("@elizaos/cloud-shared/lib/voice-session/config", () => ({
  resolveVoiceUsageLimits: () => ({}),
}));
const actualCartesiaInk = {
  ...(await import("@elizaos/host/voice/cartesia-ink")),
};
mock.module("@elizaos/host/voice/cartesia-ink", () => ({
  ...actualCartesiaInk,
  createCartesiaInkRealtimeSession() {},
}));
const actualCartesiaSonic = {
  ...(await import("@elizaos/host/voice/cartesia-sonic-tts")),
};
mock.module("@elizaos/host/voice/cartesia-sonic-tts", () => ({
  ...actualCartesiaSonic,
  CartesiaSonicTtsAdapter: class {
    close() {
      control.adapterCloses++;
    }
    async closeAndConfirm() {
      return "transport_closed";
    }
  },
}));
const actualSocketFactories = {
  ...(await import("../v1/voice/session/lib/provider-socket-factory")),
};
mock.module("../v1/voice/session/lib/provider-socket-factory", () => ({
  ...actualSocketFactories,
  createWorkerCartesiaFactory: () => () => {},
  createWorkerCartesiaInkFactory: () => () => {},
}));
mock.module("../v1/voice/stt/cartesia-pricing", () => ({
  parseCartesiaUsdPerCredit: () => 0.001,
}));
mock.module("../v1/voice/tts/provider-selection", () => ({
  resolveCartesiaVoiceId: () => "voice",
}));
mock.module("./speech-revocation-subscription", () => ({
  subscribeSpeechRevocation: async () => {
    control.subscribed++;
    await control.subscriptionWait;
    return () => {
      control.unsubscribed++;
    };
  },
}));
mock.module("./speech-relay-admission", () => ({
  reserveSpeechRelayAdmission: async (
    input: Parameters<typeof reserveSpeechRelayAdmission>[0],
  ) => {
    for (const kind of ["stt", "tts"] as const)
      await input.onProgress?.(kind, {
        state: "settled_actual",
        requestId: `speech:${input.sessionId}:${kind}`,
        amountUsd: "0",
      });
    return {};
  },
}));
const actualSpeechRelaySession = {
  ...(await import("@elizaos/host/voice/speech-relay-session")),
};
mock.module("@elizaos/host/voice/speech-relay-session", () => ({
  ...actualSpeechRelaySession,
  createSpeechRelaySession: async (
    identity: Parameters<
      typeof actualSpeechRelaySession.createSpeechRelaySession
    >[0],
    _nonce: unknown,
    ports: SpeechRelayPorts,
  ) => {
    control.opens++;
    const handle: SpeechRelayRetirementHandle = {
      async close() {
        control.closes++;
        control.afterClose?.();
        if (control.closeFails) throw Error("unknown cleanup");
      },
      async retryRetirement() {
        return this.close();
      },
      async finalizeUnknownTtsAccounting() {
        control.finalized++;
        if (control.finalizerFailure) throw control.finalizerFailure;
      },
      evidence: () => ({
        stt: "gracefully_drained",
        tts: control.ttsUnknown ? "unknown" : "transport_closed",
        accounting: "settled_actual",
      }),
    };
    if (!ports.registerRetirement)
      throw Error("Missing retirement registration");
    ports.registerRetirement(handle);
    await ports.reserveCredits(
      identity,
      actualSpeechRelaySession.SPEECH_RELAY_BUDGET,
    );
    await control.wait;
    return { retirement: handle, close: () => handle.close() };
  },
}));
const { SpeechRelayCoordinator } = await import("./speech-relay-coordinator");
const id = "00000000-0000-4000-8000-000000000001",
  owner = "00000000-0000-4000-8000-000000000002",
  org = "00000000-0000-4000-8000-000000000003";
function fixture() {
  let row: SpeechLifecycleRecord | undefined,
    queue = Promise.resolve(),
    failProof = false,
    failAlarm = false,
    beforeTransaction: (() => void) | undefined;
  let alarmSets = 0,
    alarmDeletes = 0,
    transactionActive = false;
  const alarmTransactions: boolean[] = [];
  const getRow = () => {
    if (!row) throw Error("Missing persisted speech fixture");
    return row;
  };
  const storage = {
    async get() {
      return structuredClone(row);
    },
    async put(_key: string, value: SpeechLifecycleRecord) {
      if (failProof && value.retirement?.proof?.state === "confirmed") {
        failProof = false;
        throw Error("proof storage failed");
      }
      row = structuredClone(value);
    },
    async setAlarm() {
      if (failAlarm) {
        failAlarm = false;
        throw Error("alarm write failed");
      }
      alarmTransactions.push(transactionActive);
      alarmSets++;
    },
    async deleteAlarm() {
      alarmDeletes++;
    },
    transaction(fn: (tx: unknown) => Promise<unknown>) {
      const next = queue.then(async () => {
        const before = beforeTransaction;
        beforeTransaction = undefined;
        before?.();
        transactionActive = true;
        const previous = structuredClone(row),
          previousAlarms = alarmSets;
        try {
          return await fn(storage);
        } catch (error) {
          row = previous;
          alarmSets = previousAlarms;
          throw error;
        } finally {
          transactionActive = false;
        }
      });
      queue = next.then(
        () => {},
        () => {},
      );
      return next;
    },
  };
  const state = {
    storage,
    waitUntil(p: Promise<unknown>) {
      void p.catch(() => {});
    },
  } as never;
  const env = {
    VOICE_SPEECH_RELAY_ENABLED: "true",
    CARTESIA_API_KEY: "synthetic",
    VOICE_REALTIME_CARTESIA_VOICE_ID: "voice",
  };
  const make = () => new SpeechRelayCoordinator(state, env as never);
  const c = make();
  const frames: unknown[] = [];
  // This unit fixture enters open() below the public Hello handshake.
  // Supply that handshake's socket boundary and observe the real ready frame.
  const access = c as unknown as {
    socket: { send(value: string | Uint8Array): void; close(): void };
    open(record: SpeechLifecycleRecord): Promise<void>;
    openingTask: Promise<void>;
  };
  access.socket = {
    send(value: string | Uint8Array) {
      frames.push(typeof value === "string" ? JSON.parse(value) : value);
    },
    close() {},
  };
  const input = {
    sessionId: id,
    tokenDigest: "a".repeat(64),
    expiresAt: Date.now() + 60000,
    caller: { user: { id: owner, organization_id: org } },
    proofVersion: 1,
  };
  const post = (
    coordinator: InstanceType<typeof SpeechRelayCoordinator>,
    path: string,
    data: unknown,
  ) =>
    coordinator.fetch(
      new Request(`https://speech-relay.internal/${path}`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    );
  const revoke = (coordinator = c) =>
    post(coordinator, "revoke", {
      userId: owner,
      organizationId: org,
      proofVersion: 1,
    });
  const open = async () => {
    const task = access.open(structuredClone(getRow()));
    access.openingTask = task;
    await task;
    expect(frames).toContainEqual({
      t: "ready",
      version: 1,
      sampleRate: 16000,
      channels: 1,
      expiresAt: new Date(input.expiresAt).toISOString(),
    });
  };
  return {
    c,
    env,
    make,
    input,
    post,
    revoke,
    open,
    alarms: () => ({ sets: alarmSets, deletes: alarmDeletes }),
    alarmTransactions,
    storedRecord: () => structuredClone(row),
    failNextAlarm() {
      failAlarm = true;
    },
    beforeNextTransaction(fn: () => void) {
      beforeTransaction = fn;
    },
    failNextProof() {
      failProof = true;
    },
    get row() {
      return getRow();
    },
    get retirement() {
      const retirement = getRow().retirement;
      if (!retirement) throw Error("Missing persisted retirement");
      return retirement;
    },
  };
}
beforeEach(() =>
  Object.assign(control, {
    ttsUnknown: false,
    finalized: 0,
    afterClose: undefined,
    closeFails: false,
    opens: 0,
    closes: 0,
    wait: undefined,
    subscriptionWait: undefined,
    subscribed: 0,
    unsubscribed: 0,
    adapterCloses: 0,
    finalizerFailure: undefined,
  }),
);
test("failed bootstrap alarm rolls back the prepared session", async () => {
  const f = fixture();
  f.failNextAlarm();
  expect((await f.post(f.c, "prepare", f.input)).status).toBe(409);
  expect(f.storedRecord()).toBeUndefined();
  expect((await f.post(f.c, "prepare", f.input)).status).toBe(200);
  expect(f.row.phase).toBe("prepared");
});
test("bootstrap session and expiry use one storage transaction", async () => {
  const f = fixture();
  expect((await f.post(f.c, "prepare", f.input)).status).toBe(200);
  expect(f.alarmTransactions).toEqual([true]);
  expect((await f.post(f.c, "prepare", f.input)).status).toBe(200);
  expect(f.alarmTransactions).toEqual([true]);
  expect(
    (
      await f.post(f.make(), "initialize", {
        ...f.input,
        tokenDigest: "b".repeat(64),
        consentDigest: f.input.tokenDigest,
      })
    ).status,
  ).toBe(200);
  expect(f.alarmTransactions).toEqual([true, true]);
});
test("a prepared session can retire after restart and reject a delayed mint", async () => {
  const f = fixture();
  expect((await f.post(f.c, "prepare", f.input)).status).toBe(200);
  expect(f.row.phase).toBe("prepared");
  const restarted = f.make();
  const foreign = await f.post(restarted, "revoke", {
    userId: org,
    organizationId: org,
    proofVersion: 1,
  });
  expect(foreign.status).toBe(404);
  const response = await f.revoke(restarted);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    revoked: true,
    retirement: { sessionId: id, mode: "never_started" },
  });
  const late = await f.post(f.make(), "initialize", {
    ...f.input,
    tokenDigest: "b".repeat(64),
    consentDigest: f.input.tokenDigest,
  });
  expect(late.status).toBe(409);
  expect(f.row.phase).toBe("closed");
  expect(control.opens).toBe(0);
});
test("the same prepared consent and owner can mint once after recreation", async () => {
  const f = fixture();
  expect((await f.post(f.c, "prepare", f.input)).status).toBe(200);
  const mint = {
    ...f.input,
    tokenDigest: "b".repeat(64),
    consentDigest: f.input.tokenDigest,
  };
  const restarted = f.make();
  expect(
    (
      await f.post(restarted, "initialize", {
        ...mint,
        consentDigest: "c".repeat(64),
      })
    ).status,
  ).toBe(409);
  // The saved consent is bound to both principal and organization after recreation.
  for (const user of [
    { id: org, organization_id: org },
    { id: owner, organization_id: owner },
  ]) {
    expect(
      (
        await f.post(f.make(), "initialize", {
          ...mint,
          caller: { user },
        })
      ).status,
    ).toBe(409);
    expect(f.row.phase).toBe("prepared");
    expect(f.row.tokenDigest).toBe(f.input.tokenDigest);
  }
  const expired = fixture();
  expect((await expired.post(expired.c, "prepare", expired.input)).status).toBe(
    200,
  );
  expired.beforeNextTransaction(() => {
    expired.row.expiresAt = Date.now() - 1;
  });
  expect(
    (
      await expired.post(expired.make(), "initialize", {
        ...expired.input,
        tokenDigest: "b".repeat(64),
        consentDigest: expired.input.tokenDigest,
      })
    ).status,
  ).toBe(409);
  expect(expired.row.phase).toBe("prepared");
  expect(control.opens).toBe(0);
  expect((await f.post(restarted, "initialize", mint)).status).toBe(200);
  expect(f.row.phase).toBe("minted");
  expect(f.row.tokenDigest).toBe(mint.tokenDigest);
  expect((await f.post(f.make(), "initialize", mint)).status).toBe(409);
  expect((await f.revoke(f.make())).status).toBe(200);
  expect(control.opens).toBe(0);
});
test("duplicate initialize cannot reset an opened record", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  const before = structuredClone(f.row);
  await f.post(f.c, "initialize", f.input);
  expect(f.row).toEqual(before);
  expect(control.opens).toBe(1);
});
test("confirmed proof survives recreation and replays byte-equivalently", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  const first = await f.revoke();
  expect(first.status).toBe(200);
  const text = await first.text();
  const second = await f.revoke(f.make());
  expect(await second.text()).toBe(text);
  expect(control.closes).toBe(1);
});
test("failed cleanup followed by recreation cannot manufacture success", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  expect((await f.revoke(f.make())).status).toBe(409);
});
test("legacy closed record is not a strong receipt", async () => {
  const f = fixture();
  const { proofVersion: _proofVersion, ...legacy } = f.input;
  await f.post(f.c, "initialize", legacy);
  expect((await f.revoke()).status).toBe(409);
});
test("pending opening cannot resurrect active state after revoke", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  let release!: () => void;
  control.wait = new Promise<void>((yes) => {
    release = yes;
  });
  const opening = f.open();
  void opening.catch(() => {});
  for (let i = 0; i < 100 && !control.opens; i++) await Promise.resolve();
  expect(control.opens).toBe(1);
  let finished = false;
  const closing = f.revoke().then((result) => {
    finished = true;
    return result;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  release();
  await opening.catch(() => {});
  expect((await closing).status).toBe(200);
  expect(f.row.phase).toBe("closed");
});

test("proof-write failure never acknowledges before a durable commit", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  f.failNextProof();
  expect((await f.revoke()).status).toBe(409);
  expect(f.retirement.proof?.state).not.toBe("confirmed");
  const failedGeneration = f.retirement.generation,
    failedAttempt = f.retirement.attempt;
  expect((await f.revoke()).status).toBe(200);
  expect(f.retirement.generation).toBeGreaterThan(failedGeneration);
  expect(f.retirement.attempt).toBeGreaterThan(failedAttempt);
});
test("late subscription after retirement is released exactly once", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  let release!: () => void;
  control.subscriptionWait = new Promise<void>((yes) => {
    release = yes;
  });
  const opening = f.open();
  void opening.catch(() => {});
  for (let i = 0; i < 100 && !control.subscribed; i++) await Promise.resolve();
  expect(control.subscribed).toBe(1);
  const closing = f.revoke();
  await Promise.resolve();
  release();
  await opening.catch(() => {});
  await closing;
  expect(control.unsubscribed).toBe(1);
  expect(control.opens).toBe(0);
});
test("mismatched initializer cannot rebind owner or proof version", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  expect(
    (await f.post(f.c, "initialize", { ...f.input, proofVersion: undefined }))
      .status,
  ).toBe(409);
  expect(f.row.proofVersion).toBe(1);
});
test("strong records require matching proof negotiation and owner", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  expect(
    (await f.post(f.c, "revoke", { userId: owner, organizationId: org }))
      .status,
  ).toBe(409);
  expect(
    (
      await f.post(f.c, "revoke", {
        userId: "other",
        organizationId: org,
        proofVersion: 1,
      })
    ).status,
  ).toBe(404);
  expect(f.row.phase).toBe("minted");
});
test("concurrent opening attempts have one durable winner", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  const results = await Promise.allSettled([f.open(), f.open()]);
  expect(
    results.filter((result) => result.status === "fulfilled"),
  ).toHaveLength(1);
  expect(control.opens).toBe(1);
  await f.revoke();
});
test("restored active record without a live capability remains unconfirmed", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  const recreated = f.make();
  const response = await f.revoke(recreated);
  expect(response.status).toBe(409);
  expect(control.closes).toBe(0);
});
test("concurrent revokes share one cleanup and persisted proof", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  const [a, b] = await Promise.all([f.revoke(), f.revoke()]);
  expect(await a.text()).toBe(await b.text());
  expect(control.closes).toBe(1);
});

test("live zero-resource configuration failure confirms no dispatch", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  f.env.CARTESIA_API_KEY = "";
  await expect(f.open()).rejects.toThrow();
  const result = await f.revoke();
  expect(result.status).toBe(200);
  expect(await retirementFrom(result)).toMatchObject({
    state: "confirmed",
    mode: "not_dispatched",
    accounting: "not_started",
  });
  expect(control.opens).toBe(0);
});

test("recreated zero-resource failure does not inherit live opening evidence", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  f.env.CARTESIA_API_KEY = "";
  await expect(f.open()).rejects.toThrow();
  expect((await f.revoke(f.make())).status).toBe(409);
});

test("alarm retries an existing live holder and preserves unknown until success", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  expect(control.closes).toBe(1);
  control.closeFails = false;
  await f.c.alarm();
  expect(control.closes).toBe(2);
  expect(f.retirement.proof?.state).toBe("confirmed");
});
test("automatic unknown cleanup is bounded, never confirmed by exhaustion", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  await f.c.alarm().catch(() => {});
  await f.c.alarm().catch(() => {});
  await f.c.alarm().catch(() => {});
  expect(control.closes).toBe(3);
  expect(f.retirement.proof?.state).toBe("unconfirmed");
});

test.each(["exhausted", "expired", "missing-holder"])(
  "recreated %s retry alarm never resets durable retirement",
  async (reason) => {
    const f = fixture();
    await f.post(f.c, "initialize", f.input);
    await f.open();
    control.closeFails = true;
    expect((await f.revoke()).status).toBe(409);
    if (reason === "exhausted") f.retirement.attempt = 3;
    if (reason === "expired") f.retirement.retryDeadlineAt = Date.now() - 1;
    const before = structuredClone(f.row);
    await f.make().alarm();
    expect(f.row).toEqual(before);
    expect(control.closes).toBe(1);
    expect(f.retirement.proof?.state).toBe("unconfirmed");
  },
);

test.each(["exhausted", "expired"])(
  "live holder obeys persisted %s retry limit",
  async (reason) => {
    const f = fixture();
    await f.post(f.c, "initialize", f.input);
    await f.open();
    control.closeFails = true;
    expect((await f.revoke()).status).toBe(409);
    if (reason === "exhausted") f.retirement.attempt = 3;
    else f.retirement.retryDeadlineAt = Date.now() - 1;
    const before = structuredClone(f.row);
    await f.c.alarm();
    expect(f.row).toEqual(before);
    expect(control.closes).toBe(1);
  },
);
test("an intervening revoke count cannot lend the alarm another attempt", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  f.beforeNextTransaction(() => {
    f.retirement.attempt = 3;
  });
  await f.c.alarm();
  expect(f.retirement.attempt).toBe(3);
  expect(control.closes).toBe(1);
  expect(f.retirement.proof?.state).toBe("unconfirmed");
});

test("live-holder deadline exhaustion finalizes its frozen counter without a third cleanup", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  control.ttsUnknown = true;
  const realNow = Date.now;
  const end = realNow() + 20000;
  control.afterClose = () => {
    Date.now = () => end;
  };
  try {
    expect((await f.revoke()).status).toBe(409);
    expect(control.finalized).toBe(1);
    expect(control.closes).toBe(1);
    expect(f.retirement.proof?.state).toBe("unconfirmed");
  } finally {
    Date.now = realNow;
  }
});

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
async function retirementFrom(
  response: Response,
): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (!isJsonRecord(value) || !isJsonRecord(value.retirement))
    throw Error("Expected retirement response object");
  return value.retirement;
}

test("D2 expired automatic alarm finalizes the live unknown holder without another provider cleanup", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  control.ttsUnknown = true;
  control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  f.retirement.retryDeadlineAt = Date.now() - 1;
  const before = structuredClone(f.row),
    alarms = f.alarms();
  const closes = control.closes,
    adapters = control.adapterCloses;
  await f.c.alarm();
  expect(control.finalized).toBe(1);
  expect(control.closes).toBe(closes);
  expect(control.adapterCloses).toBe(adapters);
  expect(control.opens).toBe(1);
  expect(f.row).toEqual(before);
  expect(f.alarms()).toEqual({
    sets: alarms.sets,
    deletes: alarms.deletes + 1,
  });
  expect(f.retirement.proof?.state).toBe("unconfirmed");
});

test("D2 capped automatic alarm never grants another attempt or fabricates an evicted holder", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  control.ttsUnknown = true;
  control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  f.retirement.attempt = 3;
  const before = structuredClone(f.row),
    alarms = f.alarms();
  const closes = control.closes,
    adapters = control.adapterCloses;
  await f.c.alarm();
  expect(control.finalized).toBe(1);
  expect(f.row).toEqual(before);
  expect(control.closes).toBe(closes);
  expect(control.adapterCloses).toBe(adapters);
  await f.make().alarm(); // Recreation has storage, not the original live capability.
  expect(control.finalized).toBe(1);
  expect(control.opens).toBe(1);
  expect(f.row).toEqual(before);
  expect(f.alarms()).toEqual({
    sets: alarms.sets,
    deletes: alarms.deletes + 2,
  });
});

test("D2 finalizer rejection remains observable and removes the alarm without changing proof or target", async () => {
  const f = fixture();
  await f.post(f.c, "initialize", f.input);
  await f.open();
  control.ttsUnknown = true;
  control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  f.retirement.retryDeadlineAt = Date.now() - 1;
  const failure = new Error(
    "canonical frozen settlement acknowledgement unavailable",
  );
  control.finalizerFailure = failure;
  const before = structuredClone(f.row),
    alarms = f.alarms();
  const closes = control.closes,
    adapters = control.adapterCloses;
  await expect(f.c.alarm()).rejects.toBe(failure);
  expect(control.finalized).toBe(1);
  expect(f.row).toEqual(before);
  expect(f.retirement.proof?.state).toBe("unconfirmed");
  expect(control.closes).toBe(closes);
  expect(control.adapterCloses).toBe(adapters);
  expect(f.alarms()).toEqual({
    sets: alarms.sets,
    deletes: alarms.deletes + 1,
  });
});

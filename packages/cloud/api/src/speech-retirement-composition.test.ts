import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { OrganizationInferenceAdmissionParams } from "@elizaos/cloud-shared/lib/services/organization-inference-admission";
import { InMemoryVoiceUsageStore } from "@elizaos/host/voice/usage";
import type { SpeechLifecycleRecord } from "./speech-retirement-state";

// Only persistence/auth/quota/provider boundaries are controlled. Coordinator,
// relay session, admission wrapper, TTS adapter and proof transitions are real.
const control = {
  quota: true,
  failAt: 0,
  ambiguous: false,
  dispatchFail: false,
  admissions: 0,
  zeroSettlements: [] as number[],
  providerFetches: 0,
  quotaReleaseLost: false,
  quotaReleaseCommits: false,
  quotaReleases: 0,
  quotaLimit: 10,
  receiptFault: "",
  failReservedProgress: false,
  liveProviders: false,
  sttOpens: 0,
  ttsOpens: 0,
  ttsClosed: false,
};
let quotaStore = new InMemoryVoiceUsageStore();
class CreditRefusal extends Error {}
mock.module(
  "@elizaos/cloud-shared/lib/services/inference-billing-fast-path",
  () => ({ InferenceBillingUnavailableError: class extends Error {} }),
);
mock.module("@elizaos/cloud-shared/lib/services/credits", () => ({
  InsufficientCreditsError: CreditRefusal,
}));
mock.module("@elizaos/cloud-shared/db/client", () => ({
  runWithDbCacheAsync: (fn: () => unknown) => fn(),
}));
mock.module("@elizaos/cloud-shared/lib/runtime/cloud-bindings", () => ({
  runWithCloudBindingsAsync: (_env: unknown, fn: () => unknown) => fn(),
  // The coordinator resolves the Cloud deployment (the consent seed) from the request-aware env.
  getCloudAwareEnv: () => ({}),
}));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({
  logger: { info() {}, error() {} },
}));
mock.module("@elizaos/cloud-shared/lib/voice-session/config", () => ({
  resolveVoiceUsageLimits: () => ({
    organizationDailyMinutes: control.quotaLimit,
    userDailyMinutes: control.quotaLimit,
  }),
}));
mock.module("@elizaos/cloud-shared/lib/services/voice-usage-meter", () => ({
  createDurableVoiceUsageStore: () => {
    const ownedQuota = quotaStore;
    return {
      checkAndRecord: async (
        ...args: Parameters<InMemoryVoiceUsageStore["checkAndRecord"]>
      ) =>
        control.quota ? ownedQuota.checkAndRecord(...args) : { allowed: false },
      release: async (
        ...args: Parameters<InMemoryVoiceUsageStore["release"]>
      ) => {
        control.quotaReleases++;
        if (control.quotaReleaseLost) {
          if (control.quotaReleaseCommits) await ownedQuota.release(...args);
          throw Error("quota release acknowledgement lost");
        }
        await ownedQuota.release(...args);
      },
    };
  },
}));
mock.module("@elizaos/cloud-shared/lib/pricing-constants", () => ({
  PLATFORM_MARKUP_MULTIPLIER: 1.2,
}));
mock.module(
  "@elizaos/cloud-shared/lib/services/organization-inference-admission",
  () => ({
    admitOrganizationInference: async (
      input: OrganizationInferenceAdmissionParams,
    ) => {
      const index = ++control.admissions;
      if (index === control.failAt)
        throw control.ambiguous
          ? Error("lost reservation acknowledgement")
          : new CreditRefusal("credits required");
      return {
        mode:
          control.receiptFault === "funded"
            ? "durable_object_funded_budget"
            : "durable_object_debit",
        markProviderDispatched: async () => {
          if (control.dispatchFail) throw Error("dispatch mark refused");
        },
        settle: async (amount: number) => {
          control.zeroSettlements.push(amount);
          if (control.receiptFault === "null") return null;
          if (control.receiptFault === "void") return;
          return {
            terminalReceipt: {
              version: 1,
              status: "canonical_completed",
              organizationId:
                control.receiptFault === "owner"
                  ? "another-org"
                  : input.context.organizationId,
              requestId:
                control.receiptFault === "request"
                  ? "another-request"
                  : input.context.requestId,
              amountUsd: amount.toFixed(6),
              mode:
                control.receiptFault === "funded"
                  ? "durable_object_funded_budget"
                  : "durable_object_debit",
            },
          };
        },
        settleUnknown: async () => {
          throw Error("unexpected conservative settlement");
        },
      };
    },
  }),
);
mock.module("./speech-revocation-subscription", () => ({
  subscribeSpeechRevocation: async () => () => {},
}));
// Controlled provider IO only: the host/admission/coordinator logic stays real.
const actualInk = { ...(await import("@elizaos/host/voice/cartesia-ink")) };
mock.module("@elizaos/host/voice/cartesia-ink", () => ({
  ...actualInk,
  createCartesiaInkRealtimeSession() {
    control.sttOpens++;
    if (!control.liveProviders)
      throw Error("unexpected STT provider acquisition");
    return {
      sendAudioChunk() {},
      cancel() {},
      drain: async () =>
        ({
          source: "provider-graceful-close",
          audioBytes: 0,
          sampleRate: 16000,
          channels: 1,
          encoding: "pcm_s16le",
        }) as const,
    };
  },
}));
const actualSonic = {
  ...(await import("@elizaos/host/voice/cartesia-sonic-tts")),
};
mock.module("@elizaos/host/voice/cartesia-sonic-tts", () => ({
  ...actualSonic,
  CartesiaSonicTtsAdapter: class {
    createStream() {
      control.ttsOpens++;
      if (!control.liveProviders)
        throw Error("unexpected TTS provider acquisition");
      return { sendPhrase() {}, finish() {}, cancel() {} };
    }
    close() {}
    async closeAndConfirm() {
      return control.ttsOpens === 0
        ? "not_dispatched"
        : control.ttsClosed
          ? "transport_closed"
          : "unknown";
    }
  },
}));
const { SpeechRelayCoordinator } = await import("./speech-relay-coordinator");
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
const resetCompositionFixture = () => {
  Object.assign(control, {
    quota: true,
    failAt: 0,
    ambiguous: false,
    dispatchFail: false,
    admissions: 0,
    zeroSettlements: [],
    providerFetches: 0,
    quotaReleaseLost: false,
    quotaReleaseCommits: false,
    quotaReleases: 0,
    quotaLimit: 10,
    receiptFault: "",
    failReservedProgress: false,
    liveProviders: false,
    sttOpens: 0,
    ttsOpens: 0,
    ttsClosed: false,
  });
  quotaStore = new InMemoryVoiceUsageStore();
};
beforeEach(() => {
  resetCompositionFixture();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: () => {
      control.providerFetches++;
      throw Error("unexpected provider fetch");
    },
  });
});
afterEach(() => {
  if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch);
  else Reflect.deleteProperty(globalThis, "fetch");
});
function fixture() {
  let row: SpeechLifecycleRecord | undefined;
  let tail = Promise.resolve();
  const getRow = () => {
    if (!row) throw Error("Missing persisted speech fixture");
    return row;
  };
  const storage = {
    get: async () => structuredClone(row),
    put: async (_key: string, value: unknown) => {
      if (
        control.failReservedProgress &&
        value &&
        typeof value === "object" &&
        "retirement" in value
      ) {
        const retirement = value.retirement;
        if (
          retirement &&
          typeof retirement === "object" &&
          "progress" in retirement
        ) {
          const progress = retirement.progress;
          if (
            progress &&
            typeof progress === "object" &&
            "stt" in progress &&
            progress.stt &&
            typeof progress.stt === "object" &&
            "state" in progress.stt &&
            progress.stt.state === "reserved"
          ) {
            control.failReservedProgress = false;
            throw Error("reserved progress persistence unavailable");
          }
        }
      }
      row = structuredClone(value) as SpeechLifecycleRecord;
    },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    transaction(fn: (store: unknown) => Promise<unknown>) {
      const next = tail.then(() => fn(storage));
      tail = next.then(
        () => {},
        () => {},
      );
      return next;
    },
  };
  const env = {
    VOICE_SPEECH_RELAY_ENABLED: "true",
    CARTESIA_API_KEY: "fixture-only",
    VOICE_REALTIME_CARTESIA_VOICE_ID: "11111111-1111-4111-8111-111111111111",
    CARTESIA_STT_USD_PER_CREDIT: "0.001",
  };
  const make = () =>
    new SpeechRelayCoordinator(
      {
        storage,
        waitUntil(p: Promise<unknown>) {
          void p.catch(() => {});
        },
      } as never,
      env as never,
    );
  const coordinator = make();
  const access = coordinator as unknown as {
    socket: { send(value: string | Uint8Array): void; close(): void };
    open(record: SpeechLifecycleRecord): Promise<void>;
    openingTask: Promise<void>;
  };
  access.socket = {
    send() {
      if (!control.liveProviders)
        throw Error("failed startup must not send ready");
    },
    close() {},
  };
  const id = "22222222-2222-4222-8222-222222222222";
  const input = {
    sessionId: id,
    tokenDigest: "a".repeat(64),
    expiresAt: Date.now() + 60000,
    proofVersion: 1,
    caller: {
      user: {
        id: "33333333-3333-4333-8333-333333333333",
        organization_id: "44444444-4444-4444-8444-444444444444",
      },
      credential: { kind: "api_key" },
    },
  };
  const post = (
    c: InstanceType<typeof SpeechRelayCoordinator>,
    path: string,
    value: unknown,
  ) =>
    c.fetch(
      new Request(`https://speech-relay.internal/${path}`, {
        method: "POST",
        body: JSON.stringify(value),
      }),
    );
  return {
    coordinator,
    make,
    input,
    post,
    get row() {
      return structuredClone(getRow());
    },
    get retirement() {
      const retirement = getRow().retirement;
      if (!retirement) throw Error("Missing persisted retirement");
      return structuredClone(retirement);
    },
    async openSuccessfully() {
      await post(coordinator, "initialize", input);
      const task = (
        coordinator as unknown as { open(record: unknown): Promise<void> }
      ).open(structuredClone(row));
      Object.assign(coordinator, { openingTask: task });
      await task;
    },
    async speak(text: string) {
      type Relay = Awaited<
        ReturnType<
          typeof import("@elizaos/host/voice/speech-relay-session")["createSpeechRelaySession"]
        >
      >;
      const relay = (coordinator as unknown as { relay?: Relay }).relay;
      if (!relay)
        throw Error("Real coordinator did not retain its actual session");
      await relay.control({ t: "tts", id: "late-proof", text });
    },
    async start() {
      await post(coordinator, "initialize", input);
      const task = access.open(structuredClone(getRow()));
      access.openingTask = task;
      await expect(task).rejects.toBeInstanceOf(Error);
    },
    revoke(c = coordinator) {
      return post(c, "revoke", {
        userId: "33333333-3333-4333-8333-333333333333",
        organizationId: "44444444-4444-4444-8444-444444444444",
        proofVersion: 1,
      });
    },
  };
}
test("real composition confirms a live zero-reservation quota refusal", async () => {
  control.quota = false;
  const f = fixture();
  await f.start();
  const response = await f.revoke();
  expect(response.status).toBe(200);
  expect(await retirementFrom(response)).toMatchObject({
    state: "confirmed",
    mode: "not_dispatched",
    accounting: "not_started",
  });
  expect(control.providerFetches).toBe(0);
});
test("real composition confirms a typed first-credit refusal without provider dispatch", async () => {
  control.failAt = 1;
  const f = fixture();
  await f.start();
  expect((await f.revoke()).status).toBe(200);
  expect(control.providerFetches).toBe(0);
  expect(control.zeroSettlements).toEqual([]);
});
test("real composition requires actual-zero rollback for partial reservations", async () => {
  control.failAt = 2;
  const f = fixture();
  await f.start();
  const response = await f.revoke();
  expect(response.status).toBe(200);
  expect((await retirementFrom(response)).accounting).toBe("settled_actual");
  expect(control.zeroSettlements).toEqual([0]);
  expect(control.providerFetches).toBe(0);
});
test("real composition keeps ambiguous reservation refusal unconfirmed", async () => {
  control.failAt = 1;
  control.ambiguous = true;
  const f = fixture();
  await f.start();
  expect((await f.revoke()).status).toBe(409);
  expect(control.providerFetches).toBe(0);
});
test("recreated coordinator cannot manufacture live zero-dispatch evidence", async () => {
  control.quota = false;
  const f = fixture();
  await f.start();
  expect((await f.revoke(f.make())).status).toBe(409);
  expect(control.providerFetches).toBe(0);
});

test("real composition reconciles zero work after a dispatch-mark refusal", async () => {
  control.dispatchFail = true;
  const f = fixture();
  await f.start();
  expect((await f.revoke()).status).toBe(200);
  expect(control.zeroSettlements).toEqual([0, 0]);
  expect(control.providerFetches).toBe(0);
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

test("N4 typed never-reserved money can confirm while quota release outcome stays independently unknown", async () => {
  for (const committed of [false, true]) {
    resetCompositionFixture();
    control.failAt = 1;
    control.quotaReleaseLost = true;
    control.quotaReleaseCommits = committed;
    control.quotaLimit = 1;
    const f = fixture();
    await f.start();
    const response = await f.revoke();
    expect(response.status).toBe(200);
    expect(await retirementFrom(response)).toMatchObject({
      state: "confirmed",
      mode: "not_dispatched",
      accounting: "not_started",
    });
    expect(f.row.quotaRelease).toBe("unknown");
    expect(control.quotaReleases).toBe(1);
    expect(control.providerFetches).toBe(0);
    expect(control.zeroSettlements).toEqual([]);
    const before = JSON.stringify(f.row);
    expect((await f.revoke()).status).toBe(200);
    expect(JSON.stringify(f.row)).toBe(before);
    expect(control.quotaReleases).toBe(1);
    const identity = {
      organizationId: f.input.caller.user.organization_id,
      userId: f.input.caller.user.id,
    };
    const limits = { organizationDailyMinutes: 1, userDailyMinutes: 1 };
    expect((await quotaStore.checkAndRecord(identity, 1, limits)).allowed).toBe(
      committed,
    );
    expect((await quotaStore.checkAndRecord(identity, 1, limits)).allowed).toBe(
      false,
    );
  }
});

test("N4 partial actual-zero rollback and never-reserved peer require both exact proofs", async () => {
  for (const fault of ["", "owner", "request", "null", "void", "funded"]) {
    resetCompositionFixture();
    control.failAt = 2;
    control.quotaReleaseLost = true;
    control.quotaLimit = 1;
    control.receiptFault = fault;
    const f = fixture();
    await f.start();
    const response = await f.revoke();
    expect(response.status).toBe(fault ? 409 : 200);
    expect((await retirementFrom(response)).state).toBe(
      fault ? "unconfirmed" : "confirmed",
    );
    expect(f.retirement.progress.tts.state).toBe("not_reserved");
    expect(f.retirement.progress.stt.state).toBe(
      fault ? "unconfirmed" : "settled_actual",
    );
    expect(f.row.quotaRelease).toBe("unknown");
    expect(control.zeroSettlements).toEqual([0]);
    expect(control.providerFetches).toBe(0);
    expect(control.quotaReleases).toBe(1);
    expect(
      (
        await quotaStore.checkAndRecord(
          {
            organizationId: f.input.caller.user.organization_id,
            userId: f.input.caller.user.id,
          },
          1,
          { organizationDailyMinutes: 1, userDailyMinutes: 1 },
        )
      ).allowed,
    ).toBe(false);
  }
});

test("N4 lost reservation or reserved-progress acknowledgement cannot create no-dispatch money proof", async () => {
  for (const fault of ["lost-admit", "progress-write"]) {
    resetCompositionFixture();
    control.quotaReleaseLost = true;
    control.quotaLimit = 1;
    if (fault === "lost-admit") {
      control.failAt = 1;
      control.ambiguous = true;
    } else {
      control.failReservedProgress = true;
      control.receiptFault = "null";
    }
    const f = fixture();
    await f.start();
    expect((await f.revoke()).status).toBe(409);
    expect(f.retirement.proof?.state).toBe("unconfirmed");
    expect(["reserving", "unconfirmed"]).toContain(
      f.retirement.progress.stt.state,
    );
    expect(control.providerFetches).toBe(0);
    expect(control.quotaReleases).toBe(1);
    await f.revoke();
    expect(control.quotaReleases).toBe(1);
    expect(
      (
        await quotaStore.checkAndRecord(
          {
            organizationId: f.input.caller.user.organization_id,
            userId: f.input.caller.user.id,
          },
          1,
          { organizationDailyMinutes: 1, userDailyMinutes: 1 },
        )
      ).allowed,
    ).toBe(false);
  }
});

test("D3 real coordinator admission and host retain conservative history after late proven transport close", async () => {
  control.liveProviders = true;
  const f = fixture();
  await f.openSuccessfully();
  await f.speak("hello");
  expect(control.admissions).toBe(2);
  for (let attempt = 0; attempt < 3; attempt++)
    expect((await f.revoke()).status).toBe(409);
  const frozen = structuredClone(f.retirement.progress.tts);
  expect(frozen).toMatchObject({
    state: "settled_conservative",
    amountUsd: "0.006",
    basis: "submitted_counter_provider_unconfirmed",
  });
  expect(control.zeroSettlements).toEqual([0, 0.006]);
  control.ttsClosed = true;
  const response = await f.revoke();
  expect(response.status).toBe(200);
  expect(await retirementFrom(response)).toMatchObject({
    state: "confirmed",
    mode: "retired",
    accounting: "settled_actual",
    tts: "transport_closed",
  });
  expect(f.retirement.progress.tts).toEqual(frozen);
  expect(control.zeroSettlements).toEqual([0, 0.006]);
  expect(control.admissions).toBe(2);
  expect(control.sttOpens).toBe(1);
  expect(control.ttsOpens).toBe(1);
  expect(control.providerFetches).toBe(0);
  const replay = await f.revoke();
  expect(replay.status).toBe(200);
  expect(control.zeroSettlements).toEqual([0, 0.006]);
});

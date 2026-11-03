import { beforeEach, expect, test, mock } from "bun:test";
const control = { ttsUnknown: false, finalized: 0, afterClose: undefined as (() => void) | undefined, closeFails: false, opens: 0, closes: 0, wait: undefined as Promise<void> | undefined, subscriptionWait: undefined as Promise<void> | undefined, subscribed: 0, unsubscribed: 0 };
mock.module("@elizaos/cloud-shared/db/client", () => ({ runWithDbCacheAsync: (fn: () => unknown) => fn() }));
mock.module("@elizaos/cloud-shared/lib/runtime/cloud-bindings", () => ({ runWithCloudBindingsAsync: (_env: unknown, fn: () => unknown) => fn() }));
mock.module("@elizaos/cloud-shared/lib/services/credits", () => ({ InsufficientCreditsError: class extends Error {} }));
mock.module("@elizaos/cloud-shared/lib/services/voice-usage-meter", () => ({ createDurableVoiceUsageStore: () => ({}) }));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({ logger: { info() {}, error() {} } }));
mock.module("@elizaos/cloud-shared/lib/voice-session/config", () => ({ resolveVoiceUsageLimits: () => ({}) }));
const actualCartesiaInk = { ...await import("@elizaos/host/voice/cartesia-ink") };
mock.module("@elizaos/host/voice/cartesia-ink", () => ({ ...actualCartesiaInk, createCartesiaInkRealtimeSession() {} }));
const actualCartesiaSonic = { ...await import("@elizaos/host/voice/cartesia-sonic-tts") };
mock.module("@elizaos/host/voice/cartesia-sonic-tts", () => ({ ...actualCartesiaSonic, CartesiaSonicTtsAdapter: class { close() {} async closeAndConfirm() { return "transport_closed"; } } }));
const actualSocketFactories = { ...await import("../v1/voice/session/lib/provider-socket-factory") };
mock.module("../v1/voice/session/lib/provider-socket-factory", () => ({ ...actualSocketFactories, createWorkerCartesiaFactory: () => () => {}, createWorkerCartesiaInkFactory: () => () => {} }));
mock.module("../v1/voice/stt/cartesia-pricing", () => ({ parseCartesiaUsdPerCredit: () => 0.001 }));
mock.module("../v1/voice/tts/provider-selection", () => ({ resolveCartesiaVoiceId: () => "voice" }));
mock.module("./speech-revocation-subscription", () => ({ subscribeSpeechRevocation: async () => { control.subscribed++; await control.subscriptionWait; return () => { control.unsubscribed++; }; } }));
mock.module("./speech-relay-admission", () => ({ reserveSpeechRelayAdmission: async (input: any) => {
  for (const kind of ["stt", "tts"] as const) await input.onProgress?.(kind, { state: "settled_actual", requestId: `speech:${input.sessionId}:${kind}`, amountUsd: "0" });
  return {};
} }));
const actualSpeechRelaySession = { ...await import("@elizaos/host/voice/speech-relay-session") };
mock.module("@elizaos/host/voice/speech-relay-session", () => ({ ...actualSpeechRelaySession, createSpeechRelaySession: async (_id: unknown, _nonce: unknown, ports: any) => {
  control.opens++;
  const handle = { async close() { control.closes++; control.afterClose?.(); if (control.closeFails) throw Error("unknown cleanup"); }, async retryRetirement() { return this.close(); }, async finalizeUnknownTtsAccounting() { control.finalized++; }, evidence: () => ({ stt: "gracefully_drained", tts: control.ttsUnknown ? "unknown" : "transport_closed", accounting: "settled_actual" }) };
  ports.registerRetirement(handle); await ports.reserveCredits(); await control.wait;
  return { retirement: handle, close: () => handle.close() };
} }));
const { SpeechRelayCoordinator } = await import("./speech-relay-coordinator");
const id = "00000000-0000-4000-8000-000000000001", owner = "00000000-0000-4000-8000-000000000002", org = "00000000-0000-4000-8000-000000000003";
function fixture() {
  let row: any, queue = Promise.resolve(), failProof = false, beforeTransaction: (() => void) | undefined;
  const storage = {
    async get() { return structuredClone(row); }, async put(_key: string, value: any) { if (failProof && value.retirement?.proof?.state === "confirmed") { failProof = false; throw Error("proof storage failed"); } row = structuredClone(value); },
    async setAlarm() {}, async deleteAlarm() {},
    transaction(fn: (tx: unknown) => Promise<unknown>) { const next = queue.then(() => { const before = beforeTransaction; beforeTransaction = undefined; before?.(); return fn(storage); }); queue = next.then(() => {}, () => {}); return next; },
  };
  const state = { storage, waitUntil(p: Promise<unknown>) { void p.catch(() => {}); } } as never;
  const env = { VOICE_SPEECH_RELAY_ENABLED: "true", CARTESIA_API_KEY: "synthetic", VOICE_REALTIME_CARTESIA_VOICE_ID: "voice" } as never;
  const make = () => new SpeechRelayCoordinator(state, env);
  const c = make();
  const frames: unknown[] = [];
  // This unit fixture enters open() below the public Hello handshake.
  // Supply that handshake's socket boundary and observe the real ready frame.
  (c as any).socket = {
    send(value: string | Uint8Array) { frames.push(typeof value === "string" ? JSON.parse(value) : value); },
    close() {},
  };
  const input = { sessionId: id, tokenDigest: "a".repeat(64), expiresAt: Date.now() + 60000, caller: { user: { id: owner, organization_id: org } }, proofVersion: 1 };
  const post = (coordinator: InstanceType<typeof SpeechRelayCoordinator>, path: string, data: unknown) => coordinator.fetch(new Request(`https://speech-relay.internal/${path}`, { method: "POST", body: JSON.stringify(data) }));
  const revoke = (coordinator = c) => post(coordinator, "revoke", { userId: owner, organizationId: org, proofVersion: 1 });
  const open = async () => {
    const task = (c as any).open(structuredClone(row)); (c as any).openingTask = task; await task;
    expect(frames).toContainEqual({ t: "ready", version: 1, sampleRate: 16000, channels: 1, expiresAt: new Date(input.expiresAt).toISOString() });
  };
  return { c, make, input, post, revoke, open, beforeNextTransaction(fn: () => void) { beforeTransaction = fn; }, failNextProof() { failProof = true; }, get row() { return row; } };
}
beforeEach(() => Object.assign(control, { ttsUnknown: false, finalized: 0, afterClose: undefined, closeFails: false, opens: 0, closes: 0, wait: undefined, subscriptionWait: undefined, subscribed: 0, unsubscribed: 0 }));
test("duplicate initialize cannot reset an opened record", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open();
  const before = structuredClone(f.row); await f.post(f.c, "initialize", f.input);
  expect(f.row).toEqual(before); expect(control.opens).toBe(1);
});
test("confirmed proof survives recreation and replays byte-equivalently", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open();
  const first = await f.revoke(); expect(first.status).toBe(200); const text = await first.text();
  const second = await f.revoke(f.make()); expect(await second.text()).toBe(text); expect(control.closes).toBe(1);
});
test("failed cleanup followed by recreation cannot manufacture success", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open(); control.closeFails = true;
  expect((await f.revoke()).status).toBe(409); expect((await f.revoke(f.make())).status).toBe(409);
});
test("legacy closed record is not a strong receipt", async () => {
  const f = fixture(); const legacy = { ...f.input } as any; delete legacy.proofVersion;
  await f.post(f.c, "initialize", legacy); expect((await f.revoke()).status).toBe(409);
});
test("pending opening cannot resurrect active state after revoke", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input);
  let release!: () => void; control.wait = new Promise<void>(yes => { release = yes; });
  const opening = f.open(); void opening.catch(() => {});
  for (let i = 0; i < 100 && !control.opens; i++) await Promise.resolve();
  expect(control.opens).toBe(1);
  let finished = false; const closing = f.revoke().then(result => { finished = true; return result; });
  await Promise.resolve(); expect(finished).toBe(false); release(); await opening.catch(() => {});
  expect((await closing).status).toBe(200); expect(f.row.phase).toBe("closed");
});

test("proof-write failure never acknowledges before a durable commit", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open(); f.failNextProof();
  expect((await f.revoke()).status).toBe(409); expect(f.row.retirement.proof?.state).not.toBe("confirmed");
  const failedGeneration = f.row.retirement.generation, failedAttempt = f.row.retirement.attempt;
  expect((await f.revoke()).status).toBe(200);
  expect(f.row.retirement.generation).toBeGreaterThan(failedGeneration);
  expect(f.row.retirement.attempt).toBeGreaterThan(failedAttempt);
});
test("late subscription after retirement is released exactly once", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input);
  let release!: () => void; control.subscriptionWait = new Promise<void>(yes => { release = yes; });
  const opening = f.open(); void opening.catch(() => {});
  for (let i = 0; i < 100 && !control.subscribed; i++) await Promise.resolve(); expect(control.subscribed).toBe(1);
  const closing = f.revoke(); await Promise.resolve(); release(); await opening.catch(() => {}); await closing;
  expect(control.unsubscribed).toBe(1); expect(control.opens).toBe(0);
});
test("mismatched initializer cannot rebind owner or proof version", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input);
  expect((await f.post(f.c, "initialize", { ...f.input, proofVersion: undefined })).status).toBe(409);
  expect(f.row.proofVersion).toBe(1);
});
test("strong records require matching proof negotiation and owner", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input);
  expect((await f.post(f.c, "revoke", { userId: owner, organizationId: org })).status).toBe(409);
  expect((await f.post(f.c, "revoke", { userId: "other", organizationId: org, proofVersion: 1 })).status).toBe(404);
  expect(f.row.phase).toBe("minted");
});
test("concurrent opening attempts have one durable winner", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input);
  const results = await Promise.allSettled([f.open(), f.open()]);
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(control.opens).toBe(1); await f.revoke();
});
test("restored active record without a live capability remains unconfirmed", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open();
  const recreated = f.make(); const response = await f.revoke(recreated);
  expect(response.status).toBe(409); expect(control.closes).toBe(0);
});
test("concurrent revokes share one cleanup and persisted proof", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open();
  const [a, b] = await Promise.all([f.revoke(), f.revoke()]);
  expect(await a.text()).toBe(await b.text()); expect(control.closes).toBe(1);
});

test("live zero-resource configuration failure confirms no dispatch", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input);
  (f.c as any).env.CARTESIA_API_KEY = "";
  await expect(f.open()).rejects.toThrow();
  const result = await f.revoke(); expect(result.status).toBe(200);
  expect((await result.json()).retirement).toMatchObject({ state: "confirmed", mode: "not_dispatched", accounting: "not_started" });
  expect(control.opens).toBe(0);
});

test("recreated zero-resource failure does not inherit live opening evidence", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); (f.c as any).env.CARTESIA_API_KEY = "";
  await expect(f.open()).rejects.toThrow(); expect((await f.revoke(f.make())).status).toBe(409);
});

test("alarm retries an existing live holder and preserves unknown until success", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open();
  control.closeFails = true; expect((await f.revoke()).status).toBe(409);
  expect(control.closes).toBe(1);
  control.closeFails = false; await f.c.alarm();
  expect(control.closes).toBe(2); expect(f.row.retirement.proof.state).toBe("confirmed");
});
test("automatic unknown cleanup is bounded, never confirmed by exhaustion", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open();
  control.closeFails = true; expect((await f.revoke()).status).toBe(409);
  await f.c.alarm().catch(() => {}); await f.c.alarm().catch(() => {}); await f.c.alarm().catch(() => {});
  expect(control.closes).toBe(3); expect(f.row.retirement.proof.state).toBe("unconfirmed");
});

test.each(["exhausted", "expired", "missing-holder"])("recreated %s retry alarm never resets durable retirement", async reason => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open(); control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  if (reason === "exhausted") f.row.retirement.attempt = 3;
  if (reason === "expired") f.row.retirement.retryDeadlineAt = Date.now() - 1;
  const before = structuredClone(f.row);
  await f.make().alarm();
  expect(f.row).toEqual(before); expect(control.closes).toBe(1);
  expect(f.row.retirement.proof.state).toBe("unconfirmed");
});

test.each(["exhausted", "expired"])("live holder obeys persisted %s retry limit", async reason => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open(); control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  if (reason === "exhausted") f.row.retirement.attempt = 3;
  else f.row.retirement.retryDeadlineAt = Date.now() - 1;
  const before = structuredClone(f.row);
  await f.c.alarm(); expect(f.row).toEqual(before); expect(control.closes).toBe(1);
});
test("an intervening revoke count cannot lend the alarm another attempt", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open(); control.closeFails = true;
  expect((await f.revoke()).status).toBe(409);
  f.beforeNextTransaction(() => { f.row.retirement.attempt = 3; });
  await f.c.alarm();
  expect(f.row.retirement.attempt).toBe(3); expect(control.closes).toBe(1);
  expect(f.row.retirement.proof.state).toBe("unconfirmed");
});

test("live-holder deadline exhaustion finalizes its frozen counter without a third cleanup", async () => {
  const f = fixture(); await f.post(f.c, "initialize", f.input); await f.open();
  control.ttsUnknown = true;
  const realNow = Date.now; const end = realNow() + 20000;
  control.afterClose = () => { Date.now = () => end; };
  try {
    expect((await f.revoke()).status).toBe(409);
    expect(control.finalized).toBe(1); expect(control.closes).toBe(1);
    expect(f.row.retirement.proof.state).toBe("unconfirmed");
  } finally { Date.now = realNow; }
});

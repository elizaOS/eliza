import { beforeEach, afterEach, expect, test, mock } from "bun:test";

// Only persistence/auth/quota/provider boundaries are controlled. Coordinator,
// relay session, admission wrapper, TTS adapter and proof transitions are real.
const control = { quota: true, failAt: 0, ambiguous: false, dispatchFail: false, admissions: 0, zeroSettlements: [] as number[], providerFetches: 0 };
class CreditRefusal extends Error {}
mock.module("@elizaos/cloud-shared/lib/services/inference-billing-fast-path", () => ({ InferenceBalanceCacheWarmingError: class extends Error {} }));
mock.module("@elizaos/cloud-shared/lib/services/credits", () => ({ InsufficientCreditsError: CreditRefusal }));
mock.module("@elizaos/cloud-shared/db/client", () => ({ runWithDbCacheAsync: (fn: () => unknown) => fn() }));
mock.module("@elizaos/cloud-shared/lib/runtime/cloud-bindings", () => ({ runWithCloudBindingsAsync: (_env: unknown, fn: () => unknown) => fn() }));
mock.module("@elizaos/cloud-shared/lib/utils/logger", () => ({ logger: { info() {}, error() {} } }));
mock.module("@elizaos/cloud-shared/lib/voice-session/config", () => ({ resolveVoiceUsageLimits: () => ({ organizationDailyMinutes: 10, userDailyMinutes: 10 }) }));
mock.module("@elizaos/cloud-shared/lib/services/voice-usage-meter", () => ({ createDurableVoiceUsageStore: () => ({ checkAndRecord: async () => ({ allowed: control.quota }), release: async () => {} }) }));
mock.module("@elizaos/cloud-shared/lib/pricing-constants", () => ({ PLATFORM_MARKUP_MULTIPLIER: 1.2 }));
mock.module("@elizaos/cloud-shared/lib/services/organization-inference-admission", () => ({ admitOrganizationInference: async (input: any) => {
  const index = ++control.admissions;
  if (index === control.failAt) throw control.ambiguous ? Error("lost reservation acknowledgement") : new CreditRefusal("credits required");
  return { mode: "durable_object_debit", markProviderDispatched: async () => { if (control.dispatchFail) throw Error("dispatch mark refused"); }, settle: async (amount: number) => { control.zeroSettlements.push(amount); return { terminalReceipt: { version: 1, status: "canonical_completed", organizationId: input.context.organizationId, requestId: input.context.requestId, amountUsd: amount.toFixed(6), mode: "durable_object_debit" } }; }, settleUnknown: async () => { throw Error("unexpected conservative settlement"); } };
} }));
mock.module("./speech-revocation-subscription", () => ({ subscribeSpeechRevocation: async () => () => {} }));
const { SpeechRelayCoordinator } = await import("./speech-relay-coordinator");
const originalFetch = Object.getOwnPropertyDescriptor(globalThis, "fetch");
beforeEach(() => {
  Object.assign(control, { quota: true, failAt: 0, ambiguous: false, dispatchFail: false, admissions: 0, zeroSettlements: [], providerFetches: 0 });
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: () => { control.providerFetches++; throw Error("unexpected provider fetch"); } });
});
afterEach(() => { if (originalFetch) Object.defineProperty(globalThis, "fetch", originalFetch); else Reflect.deleteProperty(globalThis, "fetch"); });
function fixture() {
  let row: any; let tail = Promise.resolve();
  const storage = { get: async () => structuredClone(row), put: async (_key: string, value: unknown) => { row = structuredClone(value); }, setAlarm: async () => {}, deleteAlarm: async () => {}, transaction(fn: (store: unknown) => Promise<unknown>) { const next = tail.then(() => fn(storage)); tail = next.then(() => {}, () => {}); return next; } };
  const env = { VOICE_SPEECH_RELAY_ENABLED: "true", CARTESIA_API_KEY: "fixture-only", VOICE_REALTIME_CARTESIA_VOICE_ID: "11111111-1111-4111-8111-111111111111", CARTESIA_STT_USD_PER_CREDIT: "0.001" };
  const make = () => new SpeechRelayCoordinator({ storage, waitUntil(p: Promise<unknown>) { void p.catch(() => {}); } } as never, env as never);
  const coordinator = make(); (coordinator as any).socket = { send() { throw Error("failed startup must not send ready"); }, close() {} };
  const id = "22222222-2222-4222-8222-222222222222";
  const input = { sessionId: id, tokenDigest: "a".repeat(64), expiresAt: Date.now() + 60000, proofVersion: 1, caller: { user: { id: "33333333-3333-4333-8333-333333333333", organization_id: "44444444-4444-4444-8444-444444444444" }, credential: { kind: "api_key" } } };
  const post = (c: InstanceType<typeof SpeechRelayCoordinator>, path: string, value: unknown) => c.fetch(new Request(`https://speech-relay.internal/${path}`, { method: "POST", body: JSON.stringify(value) }));
  return { coordinator, make, input, post, async start() { await post(coordinator, "initialize", input); const task = (coordinator as any).open(structuredClone(row)); (coordinator as any).openingTask = task; await expect(task).rejects.toBeInstanceOf(Error); }, revoke(c = coordinator) { return post(c, "revoke", { userId: "33333333-3333-4333-8333-333333333333", organizationId: "44444444-4444-4444-8444-444444444444", proofVersion: 1 }); } };
}
test("real composition confirms a live zero-reservation quota refusal", async () => {
  control.quota = false; const f = fixture(); await f.start(); const response = await f.revoke(); expect(response.status).toBe(200); expect((await response.json()).retirement).toMatchObject({ state: "confirmed", mode: "not_dispatched", accounting: "not_started" }); expect(control.providerFetches).toBe(0);
});
test("real composition confirms a typed first-credit refusal without provider dispatch", async () => {
  control.failAt = 1; const f = fixture(); await f.start(); expect((await f.revoke()).status).toBe(200); expect(control.providerFetches).toBe(0); expect(control.zeroSettlements).toEqual([]);
});
test("real composition requires actual-zero rollback for partial reservations", async () => {
  control.failAt = 2; const f = fixture(); await f.start(); const response = await f.revoke(); expect(response.status).toBe(200); expect((await response.json()).retirement.accounting).toBe("settled_actual"); expect(control.zeroSettlements).toEqual([0]); expect(control.providerFetches).toBe(0);
});
test("real composition keeps ambiguous reservation refusal unconfirmed", async () => {
  control.failAt = 1; control.ambiguous = true; const f = fixture(); await f.start(); expect((await f.revoke()).status).toBe(409); expect(control.providerFetches).toBe(0);
});
test("recreated coordinator cannot manufacture live zero-dispatch evidence", async () => {
  control.quota = false; const f = fixture(); await f.start(); expect((await f.revoke(f.make())).status).toBe(409); expect(control.providerFetches).toBe(0);
});

test("real composition reconciles zero work after a dispatch-mark refusal", async () => {
  control.dispatchFail = true; const f = fixture(); await f.start(); expect((await f.revoke()).status).toBe(200);
  expect(control.zeroSettlements).toEqual([0, 0]); expect(control.providerFetches).toBe(0);
});

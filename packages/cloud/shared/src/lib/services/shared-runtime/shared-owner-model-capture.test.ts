/** Offline contracts only: real redaction/KMS/field crypto, synthetic owner and R2. */
import { afterEach, expect, test } from "bun:test";
import { resetKmsClientForTests } from "../../../db/crypto/kms-client";
import type { RuntimeR2Bucket } from "../../storage/r2-runtime-binding";
import { createOwnerCaptureBuffer, type OwnerCapturePayload } from "./shared-owner-model-capture";
import { cleanupDueOwnerCaptures, listOwnerCaptureReservations, cleanupExpiredOwnerCapture, parseOwnerCapturePolicy, readEncryptedOwnerCapture, reserveOwnerModelCapture, type OwnerCaptureBudgetStorage, type OwnerCapturePolicy } from "./shared-owner-model-capture-store";

const scope = { organizationId: "11111111-1111-4111-a111-111111111111", userId: "22222222-2222-4222-a222-222222222222", roomId: "33333333-3333-4333-a333-333333333333", traceId: "a".repeat(32) };
const { traceId: _notPolicy, ...ownerScope } = scope;
const policy: OwnerCapturePolicy = { version: 1, sessionId: "44444444-4444-4444-a444-444444444444", ...ownerScope, readerUserId: scope.userId, issuedAt: 1000, expiresAt: 61_000, retainUntil: 86_001_000, maxTurns: 2, maxCalls: 32, maxBytes: 4 * 1024 * 1024 };
// Policy has no trace selector; scope is independently server-resolved per turn.
const policyJson = policy;
const principal = { organizationId: scope.organizationId, userId: scope.userId, authenticatedOwner: true };
afterEach(() => resetKmsClientForTests());

function storage() {
  const rows = new Map<string, unknown>();
  let tail = Promise.resolve(); let transactions = 0; let writes = 0;
  const value: OwnerCaptureBudgetStorage = {
    async transaction<T>(fn: Parameters<OwnerCaptureBudgetStorage["transaction"]>[0]): Promise<T> {
      transactions += 1;
      const prior = tail; let release = () => {};
      tail = new Promise<void>((resolve) => { release = resolve; });
      await prior;
      try {
        return await fn({
          get: async <R>(key: string) => structuredClone(rows.get(key)) as R | undefined,
          put: async <R>(key: string, data: R) => { writes += 1; rows.set(key, structuredClone(data)); },
        }) as T;
      } finally { release(); }
    },
  };
  return { value, rows, counts: () => ({ transactions, writes }) };
}
function bucket(hang = false) {
  const objects = new Map<string, string>(); let gets = 0; let puts = 0; let deletes = 0;
  const value: RuntimeR2Bucket = {
    async get(key) {
      gets += 1; const body = objects.get(key); if (body === undefined) return null;
      return { size: new TextEncoder().encode(body).byteLength, body: new Blob([body]).stream(), text: async () => body, version: "synthetic-version" };
    },
    async put(key, body) {
      puts += 1;
      if (hang) return await new Promise<never>(() => {});
      if (typeof body !== "string" || objects.has(key)) throw new Error("Synthetic immutable write rejected");
      objects.set(key, body); return { version: "synthetic-version" };
    },
    async delete(key) { deletes += 1; objects.delete(key); },
  };
  return { value, objects, counts: () => ({ gets, puts, deletes }) };
}
function request(capture: NonNullable<Awaited<ReturnType<typeof reserveOwnerModelCapture>>["capture"]>) {
  capture.canonicalActionArgumentsAvailable();
  const call = capture.request({ messages: [{ role: "user", content: "alpha ".repeat(12_604) }], tools: [{ name: "WEB_SEARCH", inputSchema: { type: "object", properties: { apiKey: { type: "string" }, thought: { type: "string" } } } }], maxOutputTokens: 256 });
  capture.result(call, { visibleText: "Synthetic visible reply", usage: { inputTokens: 12_604, outputTokens: 157, totalTokens: 12_761 } });
}

test("buffer retains realistic SDK context/schema and separates unknown from known zero", () => {
  let saved: OwnerCapturePayload | undefined;
  const mutableScope = { ...scope }; const limits = { ...policyJson };
  const capture = createOwnerCaptureBuffer(mutableScope, limits, (payload) => { saved = payload; }, () => 1000);
  request(capture);
  mutableScope.userId = "55555555-5555-4555-a555-555555555555"; limits.maxBytes = 1;
  const call = capture.request({ messages: [] });
  capture.result(call, { usage: { inputTokens: 0, outputTokens: null, totalTokens: null } });
  capture.finish({ state: "cloud-response-ready" });
  expect(saved?.scope.userId).toBe(scope.userId);
  expect(saved?.coverage.omittedEvents).toBe(0);
  const encoded = JSON.stringify(saved);
  expect(encoded.includes('"apiKey":{"type":"string"}')).toBe(true);
  expect(encoded.includes('"thought":{"type":"string"}')).toBe(true);
  expect(encoded.includes('"inputTokens":0')).toBe(true);
  expect(encoded.includes('"outputTokens":null')).toBe(true);
});

test("buffer excludes credentials/hidden reasoning and exposes bounded omissions", () => {
  const capture = createOwnerCaptureBuffer(scope, policyJson, () => {}, () => 1000);
  capture.canonicalActionArgumentsAvailable();
  const call = capture.request({ messages: [{ role: "user", content: "Synthetic input" }], headers: { Authorization: "Bearer csk-offline-canary-123456789" } });
  capture.result(call, { visibleText: '{"thought":"hidden-chain-canary","messageToUser":"Visible reply"}', toolCalls: [{ input: { apiKey: "csk-offline-canary-123456789", query: "public weather" } }] });
  capture.request({ messages: [{ role: "user", content: "x".repeat(1024 * 1024 + 1) }] });
  const data = capture.snapshot(); const encoded = JSON.stringify(data);
  expect(encoded.includes("hidden-chain-canary")).toBe(false);
  expect(encoded.includes("csk-offline-canary-123456789")).toBe(false);
  expect(data.coverage.exactFull).toBe(false);
  expect(data.coverage.redactedFields).toBeGreaterThan(0);
  expect(data.coverage.omittedFields).toBeGreaterThan(0);
});

test("buffer never invokes getters and handles asynchronous persist rejection", async () => {
  let getterCalls = 0; let unhandled = 0;
  const listener = () => { unhandled += 1; }; process.on("unhandledRejection", listener);
  try {
    const capture = createOwnerCaptureBuffer(scope, policyJson, async () => { throw new Error("Synthetic observer failure"); }, () => 1000);
    const input = Object.defineProperty({}, "payload", { enumerable: true, get: () => { getterCalls += 1; throw new Error("Synthetic getter"); } });
    capture.request(input); capture.finish({ state: "synthetic" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getterCalls).toBe(0); expect(unhandled).toBe(0);
    expect(capture.snapshot().coverage.omittedFields).toBeGreaterThan(0);
  } finally { process.off("unhandledRejection", listener); }
});

test("admission rejects foreign scope and durable count survives new factory instances", async () => {
  const s = storage(); const b = bucket(); const pending: Promise<unknown>[] = [];
  const params = { policyValue: JSON.stringify({ ...policyJson, maxTurns: 1 }), verifiedPersonalShared: true, scope, storage: s.value, bucket: b.value, waitUntil: (work: Promise<unknown>) => { pending.push(work); }, now: () => 1000 };
  const foreign = await reserveOwnerModelCapture({ ...params, scope: { ...scope, userId: "55555555-5555-4555-a555-555555555555" } });
  expect(foreign.state).toBe("scope-mismatch"); expect(s.counts().transactions).toBe(0);
  const first = await reserveOwnerModelCapture(params); expect(first.state).toBe("admitted");
  const second = await reserveOwnerModelCapture(params); expect(second.state).toBe("exhausted");
  expect(b.counts().puts).toBe(0); expect(s.counts().writes).toBe(2);
});

test("real org field crypto stores only ciphertext and owner can read after admission closes", async () => {
  const s = storage(); const b = bucket(); const pending: Promise<unknown>[] = [];
  const admitted = await reserveOwnerModelCapture({ policyValue: JSON.stringify(policyJson), verifiedPersonalShared: true, scope, storage: s.value, bucket: b.value, waitUntil: (work) => { pending.push(work); }, now: () => 1000 });
  expect(admitted.capture).toBeDefined(); request(admitted.capture!); admitted.capture!.finish({ state: "cloud-response-ready" });
  await Promise.all(pending);
  expect(admitted.persistence.state).toBe("stored");
  const ciphertext = [...b.objects.values()][0] ?? "";
  expect(ciphertext.includes("Synthetic visible reply")).toBe(false);
  expect(ciphertext.includes(scope.userId)).toBe(false);
  const locator = admitted.locator!;
  const read = await readEncryptedOwnerCapture({ bucket: b.value, storage: s.value, locator, principal, roomId: scope.roomId, now: () => policyJson.expiresAt + 1 });
  expect(read.objectAuthenticated).toBe(true); expect(read.durableStatus).toBe("stored");
  expect(read.payload?.scope.traceId).toBe(scope.traceId);
  expect(s.counts().writes).toBe(3);
});

test("read/cleanup enforce admitted locator, immutable retention and authenticated AAD", async () => {
  const s = storage(); const b = bucket(); const pending: Promise<unknown>[] = [];
  const admitted = await reserveOwnerModelCapture({ policyValue: JSON.stringify(policyJson), verifiedPersonalShared: true, scope, storage: s.value, bucket: b.value, waitUntil: (work) => { pending.push(work); }, now: () => 1000 });
  request(admitted.capture!); admitted.capture!.finish({ state: "cloud-response-ready" }); await Promise.all(pending);
  const params = { bucket: b.value, storage: s.value, locator: admitted.locator!, principal, roomId: scope.roomId, now: () => 1000 };
  await expect(readEncryptedOwnerCapture({ ...params, principal: { ...principal, authenticatedOwner: false } })).rejects.toThrow("FORBIDDEN");
  await expect(readEncryptedOwnerCapture({ ...params, principal: { ...principal, userId: "55555555-5555-4555-a555-555555555555" } })).rejects.toThrow("FORBIDDEN");
  await expect(readEncryptedOwnerCapture({ ...params, roomId: "55555555-5555-4555-a555-555555555555" })).rejects.toThrow("FORBIDDEN");
  expect(b.counts().gets).toBe(0);
  await expect(readEncryptedOwnerCapture({ ...params, now: () => policyJson.retainUntil + 1 })).rejects.toThrow("EXPIRED");
  expect(b.counts().deletes).toBe(0);
  const arbitrary = { sessionId: policyJson.sessionId, captureId: "66666666-6666-4666-a666-666666666666" };
  await expect(cleanupExpiredOwnerCapture({ ...params, locator: arbitrary, now: () => policyJson.retainUntil + 1 })).rejects.toThrow("NOT_ADMITTED");
  expect(b.counts().deletes).toBe(0);
  const budgetKey = "owner-model-capture-budget:" + policyJson.sessionId;
  const original = structuredClone(s.rows.get(budgetKey));
  const changed = structuredClone(original) as { policy: OwnerCapturePolicy };
  changed.policy.retainUntil += 1000; s.rows.set(budgetKey, changed);
  await expect(readEncryptedOwnerCapture(params)).rejects.toThrow("UNAVAILABLE");
  expect(b.counts().deletes).toBe(0); s.rows.set(budgetKey, original);
  await cleanupExpiredOwnerCapture({ ...params, now: () => policyJson.retainUntil + 1 });
  expect(b.counts().deletes).toBe(1);
});

test("bounded native-write uncertainty persists unknown without retry or false full", async () => {
  const s = storage(); const b = bucket(true); const pending: Promise<unknown>[] = [];
  const admitted = await reserveOwnerModelCapture({ policyValue: JSON.stringify(policyJson), verifiedPersonalShared: true, scope, storage: s.value, bucket: b.value, waitUntil: (work) => { pending.push(work); }, now: () => 1000 });
  request(admitted.capture!); admitted.capture!.finish({ state: "cloud-response-ready" });
  await Promise.all(pending);
  expect(admitted.persistence.state).toBe("unknown"); expect(b.counts().puts).toBe(1);
  const read = await readEncryptedOwnerCapture({ bucket: b.value, storage: s.value, locator: admitted.locator!, principal, roomId: scope.roomId, now: () => 1000 });
  expect(read.durableStatus).toBe("unknown"); expect(read.payload).toBeNull();
}, 20_000);

test("policy separates <=one-hour capture admission from <=24-hour immutable retention", () => {
  expect(parseOwnerCapturePolicy(JSON.stringify(policyJson))).toBeDefined();
  expect(parseOwnerCapturePolicy(JSON.stringify({ ...policyJson, expiresAt: 3_601_001 }))).toBeUndefined();
  expect(parseOwnerCapturePolicy(JSON.stringify({ ...policyJson, retainUntil: 86_401_001 }))).toBeUndefined();
  expect(parseOwnerCapturePolicy(JSON.stringify({ ...policyJson, enableFromRequest: true }))).toBeUndefined();
});

test("canonical starts require matching terminal execution and SDK timing; denied gates are not executions", () => {
  const capture = createOwnerCaptureBuffer(scope, { maxCalls: 32, maxBytes: 4 * 1024 * 1024, expiresAt: 1000 }, () => {}, () => 1);
  capture.canonicalActionArgumentsAvailable();
  capture.canonicalTool({ phase: "gate", executionId: "11111111-1111-4111-a111-111111111111", redactedFields: 0, redactedStrings: 0, omittedFields: 0 });
  expect(capture.snapshot().coverage.toolExecutionsStarted).toBe(0);
  const call = capture.request({ messages: [{ role: "user", content: "synthetic owned input" }] });
  capture.result(call, { visibleText: "visible", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  expect(capture.snapshot().coverage.pendingTimings).toBe(1);
  expect(capture.snapshot().coverage.exactFull).toBe(false);
  capture.modelTiming(call, { provider: "cerebras", durationMs: 5, fallback: false });
  const tool = { executionId: "22222222-2222-4222-a222-222222222222", redactedFields: 0, redactedStrings: 0, omittedFields: 0 };
  capture.canonicalTool({ ...tool, phase: "started" });
  expect(capture.snapshot().coverage.pendingToolExecutions).toBe(1);
  expect(capture.snapshot().coverage.exactFull).toBe(false);
  capture.canonicalTool({ ...tool, phase: "settled" });
  expect(capture.snapshot().coverage.exactFull).toBe(true);
  capture.canonicalTool({ ...tool, executionId: "33333333-3333-4333-a333-333333333333", phase: "settled" });
  expect(capture.snapshot().coverage.exactFull).toBe(false);
});

test("known seven-character restored secret is excluded under an innocuous SDK input key", () => {
  const capture = createOwnerCaptureBuffer(scope, { maxCalls: 32, maxBytes: 4 * 1024 * 1024, expiresAt: 1000 }, () => {}, () => 1);
  capture.protectSecrets((text) => text, ["q7z9abc"]);
  capture.request({ innocuous: "value q7z9abc embedded" });
  expect(JSON.stringify(capture.snapshot())).not.toContain("q7z9abc");
  expect(capture.snapshot().coverage.redactedStrings).toBe(1);
  expect(capture.snapshot().coverage.exactFull).toBe(false);
});

test("private locator discovery enforces immutable reader and retention without R2 payload reads", async () => {
  const s = storage(); const b = bucket();
  const admitted = await reserveOwnerModelCapture({ policyValue: JSON.stringify(policy), verifiedPersonalShared: true, scope, storage: s.value, bucket: b.value, waitUntil: () => {}, now: () => 1000 });
  const params = { storage: s.value, sessionId: policy.sessionId, principal: { ...principal, authenticatedOwner: false, verifiedAdmin: true }, roomId: scope.roomId, now: () => policy.expiresAt + 1 };
  const listed = await listOwnerCaptureReservations(params);
  expect(listed.captures[0]?.captureId).toBe(admitted.locator?.captureId);
  expect(listed.captures[0]?.status).toBe("pending");
  expect(b.counts().gets).toBe(0);
  await expect(listOwnerCaptureReservations({ ...params, principal: { ...params.principal, userId: "55555555-5555-4555-a555-555555555555" } })).rejects.toThrow("FORBIDDEN");
  await expect(listOwnerCaptureReservations({ ...params, now: () => policy.retainUntil })).rejects.toThrow("EXPIRED");
});

test("missing ciphertext cleanup is bounded and durably reported without deleting unproven objects", async () => {
  const s = storage(); const b = bucket();
  await reserveOwnerModelCapture({ policyValue: JSON.stringify(policy), verifiedPersonalShared: true, scope, storage: s.value, bucket: b.value, waitUntil: () => {}, now: () => 1000 });
  const params = { storage: s.value, bucket: b.value, now: () => policy.retainUntil + 1 };
  expect((await cleanupDueOwnerCaptures(params)).nextDeadline).toBeDefined();
  expect((await cleanupDueOwnerCaptures(params)).nextDeadline).toBeDefined();
  const exhausted = await cleanupDueOwnerCaptures(params);
  expect(exhausted.cleanupExhausted).toBe(1);
  expect(exhausted.nextDeadline).toBeUndefined();
  expect(b.counts().deletes).toBe(0);
  const gets = b.counts().gets;
  await cleanupDueOwnerCaptures(params);
  expect(b.counts().gets).toBe(gets);
  const row = s.rows.get("owner-model-capture-budget:" + policy.sessionId) as { captures: Array<{ status: string }> };
  expect(row.captures[0]?.status).toBe("cleanup-failed");
});

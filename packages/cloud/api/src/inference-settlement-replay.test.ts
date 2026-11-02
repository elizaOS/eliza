import { expect, test } from "bun:test";
import { InferenceAdmissionGate } from "./inference-admission-gate";

function fixture(legacy = false, id = "speech:11111111-1111-4111-8111-111111111111:tts") {
  const now = Date.now(), expiresAt = now + 60000;
  let rows = new Map<string, any>();
  rows.set("ledger", { balanceRevision: "1", balanceView: "funding", balanceCeilingUsd: 10, availableUsd: legacy ? 10 : 9, uncollectedDebtUsd: 0, activeLeaseCount: legacy ? 0 : 1, activeEstimateUsd: legacy ? 0 : 1, nextAlarmAt: legacy ? null : expiresAt, settledRequestIds: legacy ? [id] : [] });
  if (!legacy) {
    rows.set(`lease:${encodeURIComponent(id)}`, { estimatedCostUsd: 1, createdAt: now, expiresAt, phase: "dispatched", recovery: { version: 1, kind: "organization", requestId: id, organizationId: "org", userId: "user", model: "sonic", provider: "cartesia", billingSource: "cartesia", description: "test", accounting: { kind: "direct_debit" } } });
    rows.set(`lease-active:${encodeURIComponent(id)}`, { requestId: id, createdAt: now, dueAt: expiresAt });
  }
  const storage = {
    get: async (key: string) => structuredClone(rows.get(key)),
    transaction: async (fn: (tx: any) => Promise<unknown>) => {
      const pending = new Map(rows);
      const tx = { get: async (key: string) => structuredClone(pending.get(key)), put: async (key: string, value: unknown) => { pending.set(key, structuredClone(value)); }, delete: async (key: string) => pending.delete(key), setAlarm: async () => {}, deleteAlarm: async () => {} };
      const result = await fn(tx); rows = pending; return result;
    },
  };
  const make = () => new InferenceAdmissionGate({ storage } as never, {} as never);
  const post = (gate: InferenceAdmissionGate, path: string, body: unknown) => gate.fetch(new Request(`https://gate.test${path}`, { method: "POST", body: JSON.stringify(body) }));
  return { id, make, post, rows: () => rows };
}
test("settlement fence replays after a lost acknowledgement and recreation", async () => {
  const f = fixture();
  const settled = await f.post(f.make(), "/settle", { requestId: f.id, balanceBackedUsd: 1, gateConsumedUsd: 1, balanceUsd: 9, balanceRevision: "2", balanceView: "funding" });
  expect(settled.status).toBe(200); // Caller discards this acknowledgement.
  const before = JSON.stringify(f.rows().get("ledger"));
  const replay = await f.post(f.make(), "/settlement-fence", { requestId: f.id, estimatedCostUsd: 1 });
  expect(replay.status).toBe(200); expect(await replay.json()).toEqual({ settlementFenced: true, estimatedCostUsd: 1, duplicate: true });
  expect(JSON.stringify(f.rows().get("ledger"))).toBe(before);
});
test("settled fence refuses changed target and legacy missing evidence", async () => {
  const f = fixture(); await f.post(f.make(), "/settle", { requestId: f.id, balanceBackedUsd: 1, gateConsumedUsd: 1, balanceUsd: 9, balanceRevision: "2", balanceView: "funding" });
  for (const estimatedCostUsd of [0.5, 2]) expect((await f.post(f.make(), "/settlement-fence", { requestId: f.id, estimatedCostUsd })).status).toBe(409);
  const legacy = fixture(true); expect((await legacy.post(legacy.make(), "/settlement-fence", { requestId: legacy.id, estimatedCostUsd: 1 })).status).toBe(409);
});

test("long non-speech settlement IDs do not duplicate into fence metadata", async () => {
  const f = fixture(false, "x".repeat(128));
  const template = structuredClone(f.rows().get(`lease:${encodeURIComponent(f.id)}`));
  f.rows().delete(`lease:${encodeURIComponent(f.id)}`);
  f.rows().delete(`lease-active:${encodeURIComponent(f.id)}`);
  for (let i = 0; i < 2056; i++) {
    const id = String(i).padStart(8, "0") + "x".repeat(120);
    const ledger = f.rows().get("ledger");
    Object.assign(ledger, { activeLeaseCount: 1, activeEstimateUsd: 1, nextAlarmAt: template.expiresAt });
    f.rows().set(`lease:${encodeURIComponent(id)}`, { ...template, recovery: { ...template.recovery, requestId: id } });
    f.rows().set(`lease-active:${encodeURIComponent(id)}`, { requestId: id, createdAt: template.createdAt, dueAt: template.expiresAt });
    const result = await f.post(f.make(), "/settle", { requestId: id, balanceBackedUsd: 1, gateConsumedUsd: 1, balanceUsd: 9, balanceRevision: String(i + 2), balanceView: "funding" });
    expect(result.status).toBe(200);
  }
  const ledger = f.rows().get("ledger");
  expect(ledger.settledRequestIds).toHaveLength(2048);
  expect(Object.keys(ledger.settledFenceEstimates ?? {})).toHaveLength(0);
  expect(new TextEncoder().encode(JSON.stringify(ledger)).length).toBeLessThan(512 * 1024);
});

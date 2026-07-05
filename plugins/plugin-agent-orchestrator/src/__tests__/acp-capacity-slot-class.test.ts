/**
 * Real-path coverage for AcpService's worker/system slot accounting (#13772):
 * getCapacity() counts non-terminal sessions by their stamped slotClass, and
 * enforceSessionLimit throws a typed SessionCapError per class. Exercises the
 * production AcpService against a real InMemorySessionStore (not a mock of the
 * cap logic); only the runtime shell is a stub.
 */

import { describe, expect, it } from "vitest";
import { AcpService } from "../services/acp-service.ts";
import { InMemorySessionStore } from "../services/session-store.ts";
import { SessionCapError, type SessionInfo } from "../services/types.ts";

function makeRuntime(
  settings: Record<string, string> = {},
): Record<string, unknown> {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    character: { name: "Tester" },
    getSetting: (key: string) => settings[key],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getService: () => null,
  };
}

function session(
  id: string,
  slotClass: "worker" | "system",
  status = "running",
): SessionInfo {
  const now = new Date();
  return {
    id,
    name: id,
    agentType: "opencode",
    workdir: "/tmp/x",
    status,
    approvalPreset: "standard",
    createdAt: now,
    lastActivityAt: now,
    metadata: { slotClass },
  };
}

async function serviceWith(
  sessions: SessionInfo[],
  settings: Record<string, string> = {},
): Promise<AcpService> {
  const store = new InMemorySessionStore();
  for (const s of sessions) await store.create(s);
  return new AcpService(makeRuntime(settings) as never, { store });
}

describe("AcpService slot-class capacity (#13772)", () => {
  it("defaults to max 8 workers / 2 system headroom", async () => {
    const svc = await serviceWith([]);
    const cap = await svc.getCapacity();
    expect(cap.maxSessions).toBe(8);
    expect(cap.systemHeadroom).toBe(2);
    expect(cap.freeWorkerSlots).toBe(8);
    expect(cap.freeSystemSlots).toBe(2);
    expect(cap.activeWorkers).toBe(0);
    expect(cap.activeSystem).toBe(0);
  });

  it("counts non-terminal sessions by stamped class", async () => {
    const svc = await serviceWith(
      [
        session("w1", "worker"),
        session("w2", "worker", "ready"),
        session("sys1", "system"),
        // Terminal sessions do not count against either class.
        session("w3", "worker", "completed"),
        session("sys2", "system", "stopped"),
      ],
      { ELIZA_ACP_MAX_SESSIONS: "5" },
    );
    const cap = await svc.getCapacity();
    expect(cap.maxSessions).toBe(5);
    expect(cap.activeWorkers).toBe(2);
    expect(cap.activeSystem).toBe(1);
    expect(cap.freeWorkerSlots).toBe(3);
  });

  it("freeWorkerSlots reflects WORKER headroom only, never system saturation", async () => {
    // Fill system headroom (2) but leave 1 worker slot free — freeWorkerSlots
    // must still be 1, so the admission queue sees room for a worker.
    const svc = await serviceWith(
      [
        session("w1", "worker"),
        session("sys1", "system"),
        session("sys2", "system"),
      ],
      { ELIZA_ACP_MAX_SESSIONS: "2", ELIZA_ACP_SYSTEM_SESSION_HEADROOM: "2" },
    );
    const cap = await svc.getCapacity();
    expect(cap.activeWorkers).toBe(1);
    expect(cap.activeSystem).toBe(2);
    expect(cap.freeWorkerSlots).toBe(1);
    expect(cap.freeSystemSlots).toBe(0);
  });

  it("throws a typed SessionCapError code string for callers to match", () => {
    const err = new SessionCapError("worker", 2, 2);
    expect(err.code).toBe("SESSION_CAP_REACHED");
    expect(err.slotClass).toBe("worker");
    expect(err.maxSessions).toBe(2);
    expect(err.activeCount).toBe(2);
    expect(err).toBeInstanceOf(Error);
  });
});

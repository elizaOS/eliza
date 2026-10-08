/** Exercises the real gate's request counters and claimed alarm mirror work without external I/O. */
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

const persisted: Array<Record<string, unknown>> = [];
let failMirror = false;
mock.module("@elizaos/cloud-shared/db/client", () => ({
  runWithDbCacheAsync: async (work: () => Promise<unknown>) => work(),
}));
mock.module("@elizaos/cloud-shared/db/repositories/anonymous-sessions", () => ({
  anonymousSessionsRepository: {
    async persistGateCounterSnapshot(value: Record<string, unknown>) {
      if (failMirror) throw new Error("fixture mirror unavailable");
      persisted.push(value);
    },
  },
}));
const { AnonymousChatGate } = await import("../src/anonymous-chat-gate");
interface FixtureStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(value: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  transaction<T>(work: (tx: FixtureStorage) => Promise<T>): Promise<T>;
}
function fixture() {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const storage: FixtureStorage = {
    async get(key: string) {
      return structuredClone(values.get(key));
    },
    async put(key: string, value: unknown) {
      values.set(key, structuredClone(value));
    },
    async setAlarm(value: number | Date) {
      alarmAt = +value;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
    async transaction<T>(work: (tx: FixtureStorage) => Promise<T>) {
      return work(storage);
    },
  };
  const gate = new AnonymousChatGate(
    { storage } as unknown as DurableObjectState,
    {} as never,
  );
  return {
    gate,
    values,
    alarm: () => alarmAt,
    post: (path: string, body: unknown = {}) =>
      gate.fetch(
        new Request(`https://fixture.invalid${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      ),
  };
}
const origin = 2_000_000;
async function hydrate(f: ReturnType<typeof fixture>) {
  return f.post("/hydrate", {
    sessionId: "session-fixture",
    userId: "user-fixture",
    messageCount: 0,
    messagesLimit: 10,
    hourlyMessageCount: 0,
    hourlyResetAtMs: null,
    hourlyLimit: 10,
    expiresAtMs: origin + 3_600_000,
    revision: 0,
    blocked: false,
  });
}
beforeEach(() => {
  persisted.length = 0;
  failMirror = false;
});
describe("Anonymous gate alarm-only mirror behavior", () => {
  test("ordinary request counters and an empty alarm do not persist a mirror", async () => {
    const now = spyOn(Date, "now").mockReturnValue(origin);
    try {
      const f = fixture();
      expect((await hydrate(f)).status).toBe(200);
      expect(
        (await f.post("/lease", { requestId: "request-fixture" })).status,
      ).toBe(200);
      expect((await f.post("/context")).status).toBe(200);
      await f.gate.alarm();
      expect(persisted).toHaveLength(0);
    } finally {
      now.mockRestore();
    }
  });
  test("claimed refund mirrors the same revision and clears only successful persistence", async () => {
    const now = spyOn(Date, "now").mockReturnValue(origin);
    try {
      const f = fixture();
      await hydrate(f);
      await f.post("/lease", { requestId: "request-fixture" });
      now.mockReturnValue(origin + 31_000);
      await f.gate.alarm();
      expect(persisted).toHaveLength(1);
      expect(persisted[0]).toMatchObject({
        sessionId: "session-fixture",
        revision: 2,
        messageCount: 0,
        hourlyMessageCount: 0,
      });
      expect(
        (f.values.get("ledger") as { pendingSnapshot: unknown })
          .pendingSnapshot,
      ).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
  test("failed mirror remains scheduled without replaying or losing the refund", async () => {
    const now = spyOn(Date, "now").mockReturnValue(origin);
    try {
      const f = fixture();
      await hydrate(f);
      await f.post("/lease", { requestId: "request-fixture" });
      now.mockReturnValue(origin + 31_000);
      failMirror = true;
      await expect(f.gate.alarm()).rejects.toThrow(
        "fixture mirror unavailable",
      );
      expect(
        (f.values.get("ledger") as { pendingSnapshot: { revision: number } })
          .pendingSnapshot.revision,
      ).toBe(2);
      expect(f.alarm()).toBeGreaterThan(origin + 31_000);
      now.mockReturnValue(origin + 92_000);
      failMirror = false;
      await f.gate.alarm();
      expect(persisted).toHaveLength(1);
      expect(persisted[0].revision).toBe(2);
      expect(
        (f.values.get("ledger") as { pendingSnapshot: unknown })
          .pendingSnapshot,
      ).toBeNull();
    } finally {
      now.mockRestore();
    }
  });
});

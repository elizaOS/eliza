/**
 * Bench-server role-seeding propagation (synthesis P0-7).
 *
 * Verifies that `/api/benchmark/reset` accepts a structured `roles` payload
 * and forwards it to the runtime's PersonalityStore via the helpers in
 * `server-utils.ts`. Without this wiring, the `scope_global_vs_user` bucket
 * cannot exercise the "global vs user-scoped directive" distinction —
 * every entity defaults to GUEST and the runtime's role gate refuses every
 * ADMIN-required personality op.
 *
 * Scope:
 *  - `parseRoleSeedPayload` accepts well-formed input and rejects garbage.
 *  - `clearPersonalityStateOnReset` calls `clear()` on the personality
 *    service when present, no-ops otherwise.
 *  - `applyRoleSeedPayload` writes the seeded directives into per-user
 *    and global personality slots.
 *  - All four `ScopeSeedMode` values round-trip through the parser.
 */

import { describe, expect, it } from "vitest";

import {
  applyRoleSeedPayload,
  clearPersonalityStateOnReset,
  isScopeSeedMode,
  parseRoleSeedPayload,
  type RoleSeedPayload,
} from "../server-utils.js";

interface RecordedSlot {
  userId: string;
  agentId: string;
  custom_directives: string[];
  source: string;
}

interface FakeStore {
  setSlot(slot: {
    userId: string;
    agentId: string;
    verbosity: string | null;
    tone: string | null;
    formality: string | null;
    reply_gate: string | null;
    custom_directives: string[];
    updated_at: string;
    source: string;
  }): void;
  clear(): void;
  cleared: number;
  slots: RecordedSlot[];
}

function fakeStore(): FakeStore {
  const store: FakeStore = {
    cleared: 0,
    slots: [],
    setSlot(slot) {
      this.slots.push({
        userId: slot.userId,
        agentId: slot.agentId,
        custom_directives: [...slot.custom_directives],
        source: slot.source,
      });
    },
    clear() {
      this.cleared += 1;
      this.slots.length = 0;
    },
  };
  return store;
}

interface FakeRuntime {
  agentId: string;
  getService: (name: string) => unknown;
}

function fakeRuntime(store: FakeStore | null): FakeRuntime {
  return {
    agentId: "agent-1",
    getService(name: string) {
      if (name === "PERSONALITY_STORE") return store;
      return null;
    },
  };
}

describe("parseRoleSeedPayload", () => {
  it("returns undefined for non-object input", () => {
    expect(parseRoleSeedPayload(null)).toBeUndefined();
    expect(parseRoleSeedPayload("a string")).toBeUndefined();
    expect(parseRoleSeedPayload(42)).toBeUndefined();
    expect(parseRoleSeedPayload([])).toBeUndefined();
  });

  it("returns undefined when all fields are missing or wrong type", () => {
    expect(parseRoleSeedPayload({})).toBeUndefined();
    expect(
      parseRoleSeedPayload({
        globalDirective: 42,
        userDirective: null,
        scopeMode: "garbage",
      }),
    ).toBeUndefined();
  });

  it("accepts a full RoleSeedPayload", () => {
    const out = parseRoleSeedPayload({
      globalDirective: "respond in metric units",
      userDirective: "I prefer imperial, convert",
      scopeMode: "user_wins",
      userId: "user-alice",
      globalRoleId: "admin-bob",
    });
    expect(out).toEqual({
      globalDirective: "respond in metric units",
      userDirective: "I prefer imperial, convert",
      scopeMode: "user_wins",
      userId: "user-alice",
      globalRoleId: "admin-bob",
    });
  });

  it("drops malformed scopeMode but keeps other fields", () => {
    const out = parseRoleSeedPayload({
      globalDirective: "always be terse",
      scopeMode: "nonsense",
      userId: "user-x",
    });
    expect(out).toEqual({
      globalDirective: "always be terse",
      userId: "user-x",
    });
    expect(out?.scopeMode).toBeUndefined();
  });
});

describe("isScopeSeedMode", () => {
  it("accepts every ScopeSeedMode value", () => {
    expect(isScopeSeedMode("global_wins")).toBe(true);
    expect(isScopeSeedMode("user_wins")).toBe(true);
    expect(isScopeSeedMode("conflict_explicit")).toBe(true);
    expect(isScopeSeedMode("conflict_implicit")).toBe(true);
  });

  it("rejects garbage and rubric-internal mode names", () => {
    expect(isScopeSeedMode("per-user-isolation")).toBe(false);
    expect(isScopeSeedMode("global-applies")).toBe(false);
    expect(isScopeSeedMode("")).toBe(false);
    expect(isScopeSeedMode(undefined)).toBe(false);
  });
});

describe("clearPersonalityStateOnReset", () => {
  it("calls clear() on the runtime's PersonalityStore", () => {
    const store = fakeStore();
    const runtime = fakeRuntime(store);
    const cleared = clearPersonalityStateOnReset(
      runtime as unknown as Parameters<typeof clearPersonalityStateOnReset>[0],
    );
    expect(cleared).toBe(true);
    expect(store.cleared).toBe(1);
  });

  it("returns false when the runtime has no PersonalityStore service", () => {
    const runtime = fakeRuntime(null);
    const cleared = clearPersonalityStateOnReset(
      runtime as unknown as Parameters<typeof clearPersonalityStateOnReset>[0],
    );
    expect(cleared).toBe(false);
  });
});

describe("applyRoleSeedPayload", () => {
  it("seeds a global directive into the GLOBAL slot when scopeMode=global_wins", () => {
    const store = fakeStore();
    const runtime = fakeRuntime(store);
    const result = applyRoleSeedPayload(
      runtime as unknown as Parameters<typeof applyRoleSeedPayload>[0],
      {
        globalDirective: "always respond in metric units",
        scopeMode: "global_wins",
        globalRoleId: "admin-1",
      },
    );
    expect(result.appliedGlobalDirective).toBe(true);
    expect(result.appliedUserDirective).toBe(false);
    expect(result.scopeMode).toBe("global_wins");
    expect(store.slots).toHaveLength(1);
    expect(store.slots[0].userId).toBe("global");
    expect(store.slots[0].custom_directives).toEqual([
      "always respond in metric units",
    ]);
    expect(store.slots[0].source).toBe("admin");
  });

  it("seeds a user directive into the per-user slot when scopeMode=user_wins", () => {
    const store = fakeStore();
    const runtime = fakeRuntime(store);
    const result = applyRoleSeedPayload(
      runtime as unknown as Parameters<typeof applyRoleSeedPayload>[0],
      {
        userDirective: "I prefer imperial units",
        scopeMode: "user_wins",
        userId: "user-alice",
      },
    );
    expect(result.appliedGlobalDirective).toBe(false);
    expect(result.appliedUserDirective).toBe(true);
    expect(result.scopeMode).toBe("user_wins");
    expect(store.slots).toHaveLength(1);
    expect(store.slots[0].userId).toBe("user-alice");
    expect(store.slots[0].source).toBe("user");
  });

  it("seeds BOTH slots when both directives are set", () => {
    const store = fakeStore();
    const runtime = fakeRuntime(store);
    const result = applyRoleSeedPayload(
      runtime as unknown as Parameters<typeof applyRoleSeedPayload>[0],
      {
        globalDirective: "always respond in metric units",
        userDirective: "I prefer imperial, convert for me",
        scopeMode: "conflict_explicit",
        userId: "user-alice",
        globalRoleId: "admin-bob",
      },
    );
    expect(result.appliedGlobalDirective).toBe(true);
    expect(result.appliedUserDirective).toBe(true);
    expect(store.slots).toHaveLength(2);
    const global = store.slots.find((s) => s.userId === "global");
    const user = store.slots.find((s) => s.userId === "user-alice");
    expect(global?.source).toBe("admin");
    expect(user?.source).toBe("user");
  });

  it("does not seed a user directive when userId is missing", () => {
    const store = fakeStore();
    const runtime = fakeRuntime(store);
    const result = applyRoleSeedPayload(
      runtime as unknown as Parameters<typeof applyRoleSeedPayload>[0],
      {
        userDirective: "I prefer imperial",
        scopeMode: "user_wins",
      },
    );
    expect(result.appliedUserDirective).toBe(false);
    expect(store.slots).toHaveLength(0);
  });

  it("no-ops cleanly when payload has only a scopeMode tag", () => {
    const store = fakeStore();
    const runtime = fakeRuntime(store);
    const result = applyRoleSeedPayload(
      runtime as unknown as Parameters<typeof applyRoleSeedPayload>[0],
      { scopeMode: "conflict_implicit" } as RoleSeedPayload,
    );
    expect(result.appliedGlobalDirective).toBe(false);
    expect(result.appliedUserDirective).toBe(false);
    expect(result.scopeMode).toBe("conflict_implicit");
    expect(store.slots).toHaveLength(0);
  });

  it("throws when the runtime cannot serve PersonalityStore but the payload carries a directive", () => {
    const runtime = fakeRuntime(null);
    expect(() =>
      applyRoleSeedPayload(
        runtime as unknown as Parameters<typeof applyRoleSeedPayload>[0],
        {
          globalDirective: "always be terse",
          scopeMode: "global_wins",
        },
      ),
    ).toThrow(/PersonalityStore service unavailable/);
  });
});

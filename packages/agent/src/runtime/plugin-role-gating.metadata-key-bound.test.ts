/**
 * The role-check dedup key is derived from `message.metadata`, the
 * connector-stamped identity blob `resolveEntityRole` consumes as live
 * connector identity (`roles.ts` `getConnectorMetadataFromMemory`). Nothing
 * bounds its nesting — `MemoryMetadata`'s `CustomMetadata` arm is
 * `[key: string]: MetadataValue`, and `agent-event-bridge.ts` reads
 * `metadata.discord` / `metadata.origin` / `metadata.session` / `metadata.sender`
 * as whatever platform payload the connector stamped.
 *
 * Key derivation runs BEFORE the role check, inside every gated provider's
 * wrapped `get()`. So an over-deep or cyclic metadata blob does not fail one
 * provider — it throws out of every role-gated provider for that turn, and
 * `AgentRuntime.composeState` drops each of them, silently emptying the
 * owner's own sensitive context.
 *
 * These tests pin the bound and, just as importantly, pin that the key does
 * not move for metadata the live path accepts today.
 */
import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  State,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rolesMock = vi.hoisted(() => ({
  checkSenderRole: vi.fn(),
}));

vi.mock("./roles.ts", () => rolesMock);

import { applyPluginRoleGating } from "./plugin-role-gating.ts";

const runtime = {
  agentId: "11111111-1111-1111-1111-111111111111",
} as IAgentRuntime;

function message(metadata: unknown): Memory {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    entityId: "33333333-3333-3333-3333-333333333333",
    roomId: "44444444-4444-4444-4444-444444444444",
    content: { text: "hi", source: "discord" },
    metadata,
  } as Memory;
}

function gatedProvider(name: string, minRole: string): Provider {
  return {
    name,
    roleGate: { minRole },
    get: vi.fn(async () => ({ text: `${name}: visible` })),
  } as unknown as Provider;
}

function gate(providers: Provider[]): Provider[] {
  applyPluginRoleGating([{ name: "test-plugin", providers } as Plugin]);
  return providers;
}

/** `{ a: { a: { ... } } }`, `levels` containers deep. */
function nest(levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { leaf: "x" };
  for (let index = 0; index < levels; index += 1) {
    node = { a: node };
  }
  return node;
}

/**
 * Deep enough to exhaust the stack in an unbounded recursive walk, and far
 * below any transport limit: `{"a":` is six bytes per level, so this whole
 * blob is well under 100 KB.
 */
const OVERFLOW_DEPTH = 12_000;

describe("role-gate dedup key — bounded metadata walk", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
    rolesMock.checkSenderRole.mockResolvedValue({
      role: "ADMIN",
      isOwner: false,
      isAdmin: true,
    });
  });

  it("still gates when connector metadata nests past the stack limit", async () => {
    const [provider] = gate([gatedProvider("SECRETS_STATUS", "ADMIN")]);

    const result = await provider.get?.(
      runtime,
      message({ discord: { userId: "u1" }, payload: nest(OVERFLOW_DEPTH) }),
      {} as State,
    );

    // The gate must still decide, not throw out of composeState.
    expect(result).toEqual({ text: "SECRETS_STATUS: visible" });
    expect(rolesMock.checkSenderRole).toHaveBeenCalledTimes(1);
  });

  it("withholds from a caller below minRole even with over-deep metadata", async () => {
    rolesMock.checkSenderRole.mockResolvedValue({
      role: "USER",
      isOwner: false,
      isAdmin: false,
    });
    const [provider] = gate([gatedProvider("SECRETS_STATUS", "ADMIN")]);

    const result = await provider.get?.(
      runtime,
      message({ payload: nest(OVERFLOW_DEPTH) }),
      {} as State,
    );

    // Over-budget metadata must not become a way to skip the gate.
    expect(result).toEqual({ text: "" });
  });

  it("still gates when connector metadata contains a cycle", async () => {
    const cyclic: Record<string, unknown> = { discord: { userId: "u1" } };
    cyclic.self = cyclic;
    const [provider] = gate([gatedProvider("SECRETS_STATUS", "ADMIN")]);

    const result = await provider.get?.(runtime, message(cyclic), {} as State);

    expect(result).toEqual({ text: "SECRETS_STATUS: visible" });
  });

  it("still gates when metadata carries an enumerable accessor", async () => {
    const hostile = {
      discord: { userId: "u1" },
    } as Record<string, unknown>;
    Object.defineProperty(hostile, "trap", {
      enumerable: true,
      get() {
        throw new Error("accessor must not run on the gate path");
      },
    });
    const [provider] = gate([gatedProvider("SECRETS_STATUS", "ADMIN")]);

    const result = await provider.get?.(runtime, message(hostile), {} as State);

    expect(result).toEqual({ text: "SECRETS_STATUS: visible" });
  });
});

/**
 * Compatibility. The dedup key's whole observable contract is "two messages
 * coalesce iff their keys are equal", so these pin that the key relation over
 * ordinary connector metadata is exactly what it was before the bound: equal
 * structures still share one role check, different structures still get their
 * own. A key that moved would silently split or merge live role decisions.
 */
const EQUIVALENT_METADATA_PAIRS: Array<[string, unknown, unknown]> = [
  [
    "key order",
    { discord: { userId: "u1", name: "a" }, type: "message" },
    { type: "message", discord: { name: "a", userId: "u1" } },
  ],
  [
    "nested arrays and nulls",
    { origin: { ids: [1, null, "x"], nested: { deep: [{ k: false }] } } },
    { origin: { nested: { deep: [{ k: false }] }, ids: [1, null, "x"] } },
  ],
  [
    "unicode and empty containers",
    { telegram: { name: "日本 🎌", tags: [], extra: {} } },
    { telegram: { extra: {}, tags: [], name: "日本 🎌" } },
  ],
  [
    "non-finite and signed-zero numbers",
    { m: { a: Number.NaN, b: Number.POSITIVE_INFINITY, c: -0 } },
    { m: { c: -0, b: Number.POSITIVE_INFINITY, a: Number.NaN } },
  ],
  [
    "sparse array holes",
    // biome-ignore lint/suspicious/noSparseArray: the hole is the fixture.
    { m: [, 1, , 2] },
    // biome-ignore lint/suspicious/noSparseArray: the hole is the fixture.
    { m: [, 1, , 2] },
  ],
  [
    "repeated (non-cyclic) reference — an honest DAG",
    (() => {
      const shared = { userId: "u1" };
      return { discord: shared, mirror: shared };
    })(),
    (() => {
      const shared = { userId: "u1" };
      return { mirror: shared, discord: shared };
    })(),
  ],
  ["absent metadata", undefined, undefined],
  ["null metadata", null, null],
  ["depth at the ceiling", { m: nest(24) }, { m: nest(24) }],
];

const DISTINCT_METADATA_PAIRS: Array<[string, unknown, unknown]> = [
  [
    "different connector user id",
    { discord: { userId: "u1" } },
    { discord: { userId: "u2" } },
  ],
  ["different value type", { m: "1" }, { m: 1 }],
  ["different array order", { m: [1, 2] }, { m: [2, 1] }],
  ["added key", { m: { a: 1 } }, { m: { a: 1, b: 2 } }],
  ["absent vs empty", undefined, {}],
];

describe("role-gate dedup key — no over-rejection, no key drift", () => {
  beforeEach(() => {
    rolesMock.checkSenderRole.mockReset();
  });

  /** Two concurrent gated providers share one role check iff the keys match. */
  async function roleChecksFor(first: unknown, second: unknown) {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    rolesMock.checkSenderRole.mockImplementation(async () => {
      await held;
      return { role: "ADMIN", isOwner: false, isAdmin: true };
    });
    const providers = gate([
      gatedProvider("SECRETS_STATUS", "ADMIN"),
      gatedProvider("MISSING_SECRETS", "ADMIN"),
    ]);
    const pending = Promise.all([
      providers[0].get?.(runtime, message(first), {} as State),
      providers[1].get?.(runtime, message(second), {} as State),
    ]);
    await Promise.resolve();
    release();
    const results = await pending;
    expect(results).toEqual([
      { text: "SECRETS_STATUS: visible" },
      { text: "MISSING_SECRETS: visible" },
    ]);
    return rolesMock.checkSenderRole.mock.calls.length;
  }

  for (const [label, first, second] of EQUIVALENT_METADATA_PAIRS) {
    it(`coalesces equivalent metadata: ${label}`, async () => {
      expect(await roleChecksFor(first, second)).toBe(1);
    });
  }

  for (const [label, first, second] of DISTINCT_METADATA_PAIRS) {
    it(`separates distinct metadata: ${label}`, async () => {
      expect(await roleChecksFor(first, second)).toBe(2);
    });
  }
});

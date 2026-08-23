/**
 * Pins the Self-Awareness v1 contracts: runtime constants, the invalidation
 * event union, and AwarenessContributor required vs optional fields. The
 * module is constants + types — tests drive real contributor objects (summary,
 * detail, empty output, optional cache/invalidation) rather than mocking the
 * contract. No live runtime or registry.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import * as awareness from "./awareness.ts";
import {
  type AwarenessContributor,
  type AwarenessInvalidationEvent,
  DEFAULT_CACHE_TTL_MS,
  SELF_STATUS_SCHEMA_VERSION,
  SUMMARY_CHAR_LIMIT,
  SUMMARY_TOTAL_CHAR_LIMIT,
} from "./awareness.ts";

const runtime = {} as IAgentRuntime;

/** Closed set of invalidation events. Adding/removing a union member fails tsc. */
const AWARENESS_INVALIDATION_EVENTS = [
  "permission-changed",
  "plugin-changed",
  "wallet-updated",
  "provider-changed",
  "config-changed",
  "runtime-restarted",
  "opinion-updated",
] as const satisfies readonly AwarenessInvalidationEvent[];

type MissingInvalidationEvent = Exclude<
  AwarenessInvalidationEvent,
  (typeof AWARENESS_INVALIDATION_EVENTS)[number]
>;
const _invalidationEventsAreExhaustive: MissingInvalidationEvent extends never
  ? true
  : MissingInvalidationEvent = true;
void _invalidationEventsAreExhaustive;

/** Documented position ladder from AwarenessContributor.position. */
const DOCUMENTED_POSITIONS = {
  runtime: 10,
  permissions: 20,
  wallet: 30,
  provider: 40,
  pluginHealth: 50,
  connectors: 60,
  cloud: 70,
  features: 80,
} as const;

function contributor(fields: {
  id: string;
  position: number;
  summary: AwarenessContributor["summary"];
  detail?: AwarenessContributor["detail"];
  cacheTtl?: number;
  invalidateOn?: AwarenessInvalidationEvent[];
  trusted?: boolean;
}): AwarenessContributor {
  const next: AwarenessContributor = {
    id: fields.id,
    position: fields.position,
    summary: fields.summary,
  };
  if (fields.detail !== undefined) {
    next.detail = fields.detail;
  }
  if (fields.cacheTtl !== undefined) {
    next.cacheTtl = fields.cacheTtl;
  }
  if (fields.invalidateOn !== undefined) {
    next.invalidateOn = fields.invalidateOn;
  }
  if (fields.trusted !== undefined) {
    next.trusted = fields.trusted;
  }
  return next;
}

describe("awareness runtime exports", () => {
  it("exports schema version 1 and a 1-minute default cache TTL", () => {
    expect(SELF_STATUS_SCHEMA_VERSION).toBe(1);
    expect(DEFAULT_CACHE_TTL_MS).toBe(60_000);
    expect(DEFAULT_CACHE_TTL_MS).toBe(1 * 60 * 1000);
  });

  it("keeps the deprecated summary character limits at their last published values", () => {
    expect(SUMMARY_CHAR_LIMIT).toBe(80);
    expect(SUMMARY_TOTAL_CHAR_LIMIT).toBe(1200);
  });

  it("exposes only the four runtime constants; types are erased", () => {
    expect(Object.keys(awareness).sort()).toEqual([
      "DEFAULT_CACHE_TTL_MS",
      "SELF_STATUS_SCHEMA_VERSION",
      "SUMMARY_CHAR_LIMIT",
      "SUMMARY_TOTAL_CHAR_LIMIT",
    ]);
    expect("AwarenessContributor" in awareness).toBe(false);
    expect("AwarenessInvalidationEvent" in awareness).toBe(false);
  });
});

describe("AwarenessInvalidationEvent", () => {
  it("is exactly the seven documented invalidation events, unique", () => {
    expect(AWARENESS_INVALIDATION_EVENTS).toHaveLength(7);
    expect(new Set(AWARENESS_INVALIDATION_EVENTS).size).toBe(7);
    expectTypeOf<AwarenessInvalidationEvent>().toEqualTypeOf<
      (typeof AWARENESS_INVALIDATION_EVENTS)[number]
    >();
  });

  it("accepts every event on invalidateOn and rejects undeclared names at the type level", () => {
    const all: AwarenessContributor = contributor({
      id: "events",
      position: 10,
      summary: async () => "",
      invalidateOn: [...AWARENESS_INVALIDATION_EVENTS],
    });
    expect(all.invalidateOn).toEqual([...AWARENESS_INVALIDATION_EVENTS]);
    expectTypeOf<AwarenessContributor["invalidateOn"]>().toEqualTypeOf<
      AwarenessInvalidationEvent[] | undefined
    >();
  });
});

describe("AwarenessContributor required fields", () => {
  it("requires id, position, and a Promise<string> summary", () => {
    expectTypeOf<AwarenessContributor["id"]>().toEqualTypeOf<string>();
    expectTypeOf<AwarenessContributor["position"]>().toEqualTypeOf<number>();
    expectTypeOf<AwarenessContributor["summary"]>().toEqualTypeOf<
      (runtime: IAgentRuntime) => Promise<string>
    >();
  });

  it("invokes summary against a real contributor and returns its text", async () => {
    const seen: IAgentRuntime[] = [];
    const c = contributor({
      id: "wallet",
      position: DOCUMENTED_POSITIONS.wallet,
      summary: async (rt) => {
        seen.push(rt);
        return "wallet ready";
      },
    });
    await expect(c.summary(runtime)).resolves.toBe("wallet ready");
    expect(seen).toEqual([runtime]);
  });

  it("treats an empty summary as valid (nothing to show)", async () => {
    const c = contributor({
      id: "quiet",
      position: 0,
      summary: async () => "",
    });
    await expect(c.summary(runtime)).resolves.toBe("");
  });
});

describe("AwarenessContributor optional fields", () => {
  it("leaves detail, cacheTtl, invalidateOn, and trusted undefined when omitted", () => {
    const c = contributor({
      id: "minimal",
      position: 10,
      summary: async () => "ok",
    });
    expect(c.detail).toBeUndefined();
    expect(c.cacheTtl).toBeUndefined();
    expect(c.invalidateOn).toBeUndefined();
    expect(c.trusted).toBeUndefined();
    expectTypeOf<AwarenessContributor["cacheTtl"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<AwarenessContributor["trusted"]>().toEqualTypeOf<
      boolean | undefined
    >();
  });

  it("calls detail with brief and full levels", async () => {
    const levels: Array<"brief" | "full"> = [];
    const c = contributor({
      id: "permissions",
      position: DOCUMENTED_POSITIONS.permissions,
      summary: async () => "permissions",
      detail: async (_rt, level) => {
        levels.push(level);
        return level === "brief" ? "brief-detail" : "full-detail";
      },
    });
    expectTypeOf<AwarenessContributor["detail"]>().toEqualTypeOf<
      | ((runtime: IAgentRuntime, level: "brief" | "full") => Promise<string>)
      | undefined
    >();
    if (!c.detail) {
      throw new Error("expected detail");
    }
    await expect(c.detail(runtime, "brief")).resolves.toBe("brief-detail");
    await expect(c.detail(runtime, "full")).resolves.toBe("full-detail");
    expect(levels).toEqual(["brief", "full"]);
  });

  it("records cacheTtl independently of the default constant", () => {
    const custom = contributor({
      id: "cached",
      position: 1,
      summary: async () => "x",
      cacheTtl: 5_000,
    });
    const zero = contributor({
      id: "no-cache",
      position: 2,
      summary: async () => "x",
      cacheTtl: 0,
    });
    expect(custom.cacheTtl).toBe(5_000);
    expect(custom.cacheTtl).not.toBe(DEFAULT_CACHE_TTL_MS);
    expect(zero.cacheTtl).toBe(0);
  });

  it("distinguishes trusted built-ins from untrusted contributors", () => {
    const builtin = contributor({
      id: "runtime",
      position: DOCUMENTED_POSITIONS.runtime,
      summary: async () => "runtime",
      trusted: true,
    });
    const plugin = contributor({
      id: "third-party",
      position: 90,
      summary: async () => "plugin",
      trusted: false,
    });
    expect(builtin.trusted).toBe(true);
    expect(plugin.trusted).toBe(false);
  });
});

describe("AwarenessContributor position ordering contract", () => {
  it("documents a strictly increasing built-in position ladder", () => {
    const values = Object.values(DOCUMENTED_POSITIONS);
    expect(values).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
    expect(new Set(values).size).toBe(values.length);
  });

  it("sorts an empty contributor list as empty", () => {
    const queue: AwarenessContributor[] = [];
    expect(
      [...queue].sort((a, b) => a.position - b.position).map((c) => c.id),
    ).toEqual([]);
  });

  it("keeps a single contributor as the only ordered element", () => {
    const only = contributor({
      id: "solo",
      position: DOCUMENTED_POSITIONS.cloud,
      summary: async () => "cloud",
    });
    expect(
      [only].sort((a, b) => a.position - b.position).map((c) => c.id),
    ).toEqual(["solo"]);
  });

  it("orders lower position ahead of higher position", () => {
    const late = contributor({
      id: "features",
      position: DOCUMENTED_POSITIONS.features,
      summary: async () => "features",
    });
    const early = contributor({
      id: "runtime",
      position: DOCUMENTED_POSITIONS.runtime,
      summary: async () => "runtime",
    });
    const mid = contributor({
      id: "provider",
      position: DOCUMENTED_POSITIONS.provider,
      summary: async () => "provider",
    });
    expect(
      [late, early, mid]
        .sort((a, b) => a.position - b.position)
        .map((c) => c.id),
    ).toEqual(["runtime", "provider", "features"]);
  });

  it("preserves insertion order on tied positions (stable sort)", () => {
    const a = contributor({
      id: "first-tie",
      position: 40,
      summary: async () => "a",
    });
    const b = contributor({
      id: "second-tie",
      position: 40,
      summary: async () => "b",
    });
    const c = contributor({
      id: "third-tie",
      position: 40,
      summary: async () => "c",
    });
    expect(
      [a, b, c]
        .sort((left, right) => left.position - right.position)
        .map((item) => item.id),
    ).toEqual(["first-tie", "second-tie", "third-tie"]);
  });

  it("accepts negative, zero, and sparse positions as ordinary numbers", () => {
    const negative = contributor({
      id: "neg",
      position: -5,
      summary: async () => "neg",
    });
    const zero = contributor({
      id: "zero",
      position: 0,
      summary: async () => "zero",
    });
    const sparse = contributor({
      id: "sparse",
      position: 10_000,
      summary: async () => "sparse",
    });
    expect(
      [sparse, negative, zero]
        .sort((a, b) => a.position - b.position)
        .map((c) => c.id),
    ).toEqual(["neg", "zero", "sparse"]);
  });
});

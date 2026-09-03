/**
 * Pins the canonical connector-id registry that config validation and
 * connector enumeration read across the stack.
 *
 * `CONNECTOR_IDS` is a composed list — core connectors followed by app-local
 * extensions — and `packages/agent/src/config/schema.ts` walks it to build the
 * heartbeat-target help text, keying its dedupe on `id.trim().toLowerCase()`
 * and skipping anything that normalizes to empty. Those three operations are
 * silent: a duplicate, a case-variant, or a blank entry is absorbed rather than
 * reported, so the invariants they rely on are asserted here at the source.
 */
import { describe, expect, it } from "vitest";
import {
  CONNECTOR_IDS,
  type ConnectorId,
  ELIZA_LOCAL_CONNECTOR_IDS,
} from "./schema.js";

/**
 * The whole registry, in order. Named in full rather than by count or by
 * spot-check: this is the assertion that fails on a silent ADDITION as well as
 * a removal, and per-entry cases cannot see an addition.
 */
const EXPECTED_CONNECTOR_IDS = [
  "bluebubbles",
  "telegram",
  "telegramAccount",
  "discord",
  "discordLocal",
  "slack",
  "twitter",
  "whatsapp",
  "imessage",
  "farcaster",
  "lens",
  "msteams",
  "feishu",
  "matrix",
  "nostr",
  "blooio",
  "twitch",
  "mattermost",
  "googlechat",
  "wechat",
] as const;

describe("CONNECTOR_IDS registry", () => {
  it("is exactly the canonical list, in order", () => {
    expect([...CONNECTOR_IDS]).toEqual([...EXPECTED_CONNECTOR_IDS]);
  });

  it.each(EXPECTED_CONNECTOR_IDS)("includes %s", (id) => {
    expect(CONNECTOR_IDS).toContain(id);
  });

  // `it.each` over an empty list registers zero cases and still reports green,
  // so the table above cannot stand alone — this pins the arity the table is
  // generated from.
  it("registers one case per connector", () => {
    expect(EXPECTED_CONNECTOR_IDS).toHaveLength(20);
    expect(CONNECTOR_IDS).toHaveLength(EXPECTED_CONNECTOR_IDS.length);
  });
});

describe("the core/local seam", () => {
  it("is exactly the app-local extensions", () => {
    expect([...ELIZA_LOCAL_CONNECTOR_IDS]).toEqual(["wechat"]);
  });

  /**
   * Pins the local tail by SUBTRACTION rather than by a second hand-written
   * copy: the core half is not exported, so deriving it from the composed list
   * keeps this honest if a core connector is added, and still fails if a local
   * one is promoted to core.
   */
  it("appends the local extensions after every core connector", () => {
    const local = new Set<string>(ELIZA_LOCAL_CONNECTOR_IDS);
    const coreHalf = CONNECTOR_IDS.filter((id) => !local.has(id));
    const localHalf = CONNECTOR_IDS.filter((id) => local.has(id));

    expect([...CONNECTOR_IDS]).toEqual([...coreHalf, ...localHalf]);
    expect(localHalf).toEqual([...ELIZA_LOCAL_CONNECTOR_IDS]);
    expect(coreHalf).toHaveLength(19);
  });

  it("keeps the two halves disjoint", () => {
    const local = new Set<string>(ELIZA_LOCAL_CONNECTOR_IDS);
    const core = CONNECTOR_IDS.filter((id) => !local.has(id));
    expect(core.filter((id) => local.has(id))).toEqual([]);
  });
});

/**
 * The consumer in `packages/agent/src/config/schema.ts` normalizes with
 * `id.trim().toLowerCase()` and `continue`s on a falsy result. Each invariant
 * below is one thing that silently loses an entry there rather than failing.
 */
describe("invariants the heartbeat-target consumer depends on", () => {
  it("contains no duplicate ids", () => {
    expect([...new Set(CONNECTOR_IDS)]).toEqual([...CONNECTOR_IDS]);
  });

  it("contains no two ids that collide once lowercased", () => {
    const lowered = CONNECTOR_IDS.map((id) => id.toLowerCase());
    const collisions = lowered.filter(
      (id, index) => lowered.indexOf(id) !== index,
    );
    expect(collisions).toEqual([]);
  });

  it("contains no id that normalizes to empty", () => {
    expect(CONNECTOR_IDS.filter((id) => !id.trim())).toEqual([]);
  });

  it("contains no id carrying whitespace, so trimming is a no-op", () => {
    expect(CONNECTOR_IDS.filter((id) => id !== id.trim())).toEqual([]);
    expect(CONNECTOR_IDS.filter((id) => /\s/.test(id))).toEqual([]);
  });

  it("survives the consumer's normalize-and-dedupe without losing an entry", () => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const id of CONNECTOR_IDS) {
      const normalized = id.trim().toLowerCase();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      ordered.push(normalized);
    }
    expect(ordered).toEqual(CONNECTOR_IDS.map((id) => id.toLowerCase()));
  });
});

describe("ConnectorId", () => {
  it("admits every registry member and nothing else", () => {
    const ids: ConnectorId[] = [...CONNECTOR_IDS];
    expect(ids).toHaveLength(CONNECTOR_IDS.length);
    // @ts-expect-error a connector id outside the registry is not assignable
    const notAConnector: ConnectorId = "myspace";
    expect(notAConnector).toBe("myspace");
  });
});

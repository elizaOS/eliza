/**
 * Observed-anchor resolvers (#12284 WI-1) through the real
 * `registerHealthAnchors` contributions and a deterministic
 * ActivitySignalReader: same-day observations resolve to their actual
 * instant; stale/future/degraded inputs resolve `null`, never throw.
 */

import { describe, expect, it } from "vitest";
import type {
  ActivitySignalReader,
  ActivitySignalRecord,
  AnchorContribution,
  AnchorRegistry,
  RuntimeWithHealthRegistries,
} from "../connectors/contract-types.js";
import {
  HEALTH_ANCHORS,
  HEALTH_BUS_FAMILIES,
  registerHealthAnchors,
} from "../connectors/index.js";
import type { LifeOpsDerivedEvent } from "../sleep/sleep-wake-events.js";
import { healthBusFamilyForDerivedEventKind } from "../sleep/sleep-wake-events.js";

/** 2026-05-09 09:00 EDT — the "now" used across the fixed timeline. */
const NOW_ISO = "2026-05-09T13:00:00.000Z";
const NY = "America/New_York";

function makeAnchorRegistry(): {
  registry: AnchorRegistry;
  anchors: AnchorContribution[];
} {
  const anchors: AnchorContribution[] = [];
  const registry: AnchorRegistry = {
    register: (anchor) => {
      anchors.push(anchor);
    },
    list: () => anchors,
    get: (anchorKey) =>
      anchors.find((anchor) => anchor.anchorKey === anchorKey) ?? null,
  };
  return { registry, anchors };
}

function makeReader(
  records: ActivitySignalRecord[],
  options: { honorFamilyFilter?: boolean; throwOnRecent?: boolean } = {},
): ActivitySignalReader {
  return {
    recent(args) {
      if (options.throwOnRecent) {
        throw new Error("reader exploded");
      }
      const sinceMs = Date.parse(args.sinceIso);
      return records.filter((record) => {
        const occurredMs = Date.parse(record.occurredAt);
        if (Number.isFinite(occurredMs) && occurredMs < sinceMs) return false;
        if (options.honorFamilyFilter === false) return true;
        return args.family === undefined || record.family === args.family;
      });
    },
  };
}

async function resolveAnchor(args: {
  anchorKey: string;
  records?: ActivitySignalRecord[];
  reader?: ActivitySignalReader | null;
  nowIso?: string;
  timezone?: string;
}): Promise<{ atIso: string } | null> {
  const { registry } = makeAnchorRegistry();
  const runtimeStub: RuntimeWithHealthRegistries = {
    anchorRegistry: registry,
  };
  if (args.reader !== null) {
    runtimeStub.activitySignalBus =
      args.reader ?? makeReader(args.records ?? []);
  }
  registerHealthAnchors(runtimeStub);
  const contribution = registry.get(args.anchorKey);
  expect(contribution).not.toBeNull();
  if (!contribution?.resolve) {
    throw new Error(`anchor ${args.anchorKey} has no resolver`);
  }
  return contribution.resolve({
    nowIso: args.nowIso ?? NOW_ISO,
    ownerFacts: { timezone: args.timezone ?? NY },
  });
}

describe("plugin-health observed-anchor resolvers (#12284 WI-1)", () => {
  it("registers all 4 anchors with real resolvers", () => {
    const { registry, anchors } = makeAnchorRegistry();
    registerHealthAnchors({ anchorRegistry: registry });
    expect(anchors.map((anchor) => anchor.anchorKey)).toEqual([
      ...HEALTH_ANCHORS,
    ]);
    for (const anchor of anchors) {
      expect(typeof anchor.resolve).toBe("function");
    }
  });

  it("wake.confirmed resolves to the actual observed wake on the day it occurred", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      records: [
        // 06:47 EDT the same local day as NOW_ISO.
        {
          family: "health.wake.confirmed",
          occurredAt: "2026-05-09T10:47:00.000Z",
        },
      ],
    });
    expect(resolved).toEqual({ atIso: "2026-05-09T10:47:00.000Z" });
  });

  it("picks the LATEST same-day observation when several exist", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.observed",
      records: [
        {
          family: "health.wake.observed",
          occurredAt: "2026-05-09T09:50:00.000Z",
        },
        {
          family: "health.wake.observed",
          occurredAt: "2026-05-09T11:40:00.000Z",
        },
        {
          family: "health.wake.observed",
          occurredAt: "2026-05-09T10:15:00.000Z",
        },
      ],
    });
    expect(resolved).toEqual({ atIso: "2026-05-09T11:40:00.000Z" });
  });

  it("resolves null when no observation exists (spine falls back to the static default)", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      records: [],
    });
    expect(resolved).toBeNull();
  });

  it("rejects yesterday's observation after local midnight even when <24h old", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      records: [
        // 19:30 EDT on May 8 — only 13.5h before NOW_ISO but the previous
        // local day, so the same-local-day freshness rule must reject it.
        {
          family: "health.wake.confirmed",
          occurredAt: "2026-05-08T23:30:00.000Z",
        },
      ],
    });
    expect(resolved).toBeNull();
  });

  it("rejects a multi-day-old observation", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      records: [
        {
          family: "health.wake.confirmed",
          occurredAt: "2026-05-07T10:47:00.000Z",
        },
      ],
    });
    expect(resolved).toBeNull();
  });

  it("rejects an observation in the future beyond clock skew", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.observed",
      records: [
        {
          family: "health.wake.observed",
          occurredAt: "2026-05-09T13:10:00.000Z",
        },
      ],
    });
    expect(resolved).toBeNull();
  });

  it("re-checks family membership even when the reader ignores the filter", async () => {
    const mixed: ActivitySignalRecord[] = [
      {
        family: "health.sleep.detected",
        occurredAt: "2026-05-09T04:00:00.000Z",
      },
      {
        family: "health.wake.confirmed",
        occurredAt: "2026-05-09T10:47:00.000Z",
      },
    ];
    const napResolved = await resolveAnchor({
      anchorKey: "nap.start",
      reader: makeReader(mixed, { honorFamilyFilter: false }),
    });
    expect(napResolved).toBeNull();
    const wakeResolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      reader: makeReader(mixed, { honorFamilyFilter: false }),
    });
    expect(wakeResolved).toEqual({ atIso: "2026-05-09T10:47:00.000Z" });
  });

  it("nap.start resolves from today's health.nap.detected transition", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "nap.start",
      records: [
        {
          family: "health.nap.detected",
          occurredAt: "2026-05-09T17:05:00.000Z",
        },
      ],
      nowIso: "2026-05-09T18:00:00.000Z",
    });
    expect(resolved).toEqual({ atIso: "2026-05-09T17:05:00.000Z" });
  });

  it("bedtime.target resolves the target carried on health.bedtime.imminent (near-future ok)", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "bedtime.target",
      records: [
        // The imminent edge's occurredAt IS the resolved bedtime target,
        // published up to 30 minutes before the target instant.
        {
          family: "health.bedtime.imminent",
          occurredAt: "2026-05-09T13:20:00.000Z",
        },
      ],
    });
    expect(resolved).toEqual({ atIso: "2026-05-09T13:20:00.000Z" });
  });

  it("bedtime.target rejects targets further than 12h from now", async () => {
    const staleTarget = await resolveAnchor({
      anchorKey: "bedtime.target",
      records: [
        {
          family: "health.bedtime.imminent",
          occurredAt: "2026-05-09T00:00:00.000Z",
        },
      ],
    });
    expect(staleTarget).toBeNull();
  });

  it("degrades the same-day comparison to UTC on an invalid owner timezone without throwing", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      records: [
        {
          family: "health.wake.confirmed",
          occurredAt: "2026-05-09T06:00:00.000Z",
        },
      ],
      timezone: "Not/AZone",
    });
    expect(resolved).toEqual({ atIso: "2026-05-09T06:00:00.000Z" });
  });

  it("resolves null (never throws) when the reader throws", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      reader: makeReader([], { throwOnRecent: true }),
    });
    expect(resolved).toBeNull();
  });

  it("skips envelopes with unparseable occurredAt", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      records: [
        { family: "health.wake.confirmed", occurredAt: "not-a-date" },
        {
          family: "health.wake.confirmed",
          occurredAt: "2026-05-09T10:47:00.000Z",
        },
      ],
    });
    expect(resolved).toEqual({ atIso: "2026-05-09T10:47:00.000Z" });
  });

  it("resolves null when the runtime exposes no ActivitySignalReader", async () => {
    const resolved = await resolveAnchor({
      anchorKey: "wake.confirmed",
      reader: null,
    });
    expect(resolved).toBeNull();
  });

  it("resolves null (never throws) on malformed resolve contexts", async () => {
    const { registry } = makeAnchorRegistry();
    registerHealthAnchors({
      anchorRegistry: registry,
      activitySignalBus: makeReader([
        {
          family: "health.wake.confirmed",
          occurredAt: "2026-05-09T10:47:00.000Z",
        },
      ]),
    });
    const contribution = registry.get("wake.confirmed");
    if (!contribution?.resolve) throw new Error("missing resolver");
    for (const context of [
      null,
      undefined,
      42,
      {},
      { nowIso: "garbage" },
      { nowIso: 12345 },
    ]) {
      expect(await contribution.resolve(context)).toBeNull();
    }
  });
});

describe("derived-event kind → bus family mapping (#12284 WI-4)", () => {
  it("maps every circadian transition kind to its registered health.* family", () => {
    const expected: Array<[LifeOpsDerivedEvent["kind"], string]> = [
      ["lifeops.sleep.detected", "health.sleep.detected"],
      ["lifeops.sleep.ended", "health.sleep.ended"],
      ["lifeops.wake.observed", "health.wake.observed"],
      ["lifeops.wake.confirmed", "health.wake.confirmed"],
      ["lifeops.nap.detected", "health.nap.detected"],
      ["lifeops.bedtime.imminent", "health.bedtime.imminent"],
      ["lifeops.regularity.changed", "health.regularity.changed"],
    ];
    for (const [kind, family] of expected) {
      expect(healthBusFamilyForDerivedEventKind(kind)).toBe(family);
      expect(HEALTH_BUS_FAMILIES).toContain(family);
    }
  });

  it("maps sleep.onset_candidate to null (no bus family; paired with sleep.detected)", () => {
    expect(
      healthBusFamilyForDerivedEventKind("lifeops.sleep.onset_candidate"),
    ).toBeNull();
  });
});

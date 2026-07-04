/**
 * Structural assertions for the persona default packs (issue #12186, B4).
 * These prove the ROUTING is structural — flexible during_window triggers,
 * anchor-relative watchers, and a soft-only escalation ladder — not that the
 * prompt content says a particular thing.
 */

import { describe, expect, it } from "vitest";
import { lintPacks } from "./lint.js";
import {
  ADHD_BODY_DOUBLE_PACK_KEY,
  adhdBodyDoublePack,
  LOW_ENERGY_SUPPORT_PACK_KEY,
  lowEnergySupportPack,
  OBJECT_PERMANENCE_WATCHER_PACK_KEY,
  objectPermanenceWatcherPack,
  PERSONA_PACKS,
  SOFT_LOW_ENERGY_ESCALATION_STEPS,
} from "./persona-packs.js";

describe("SOFT_LOW_ENERGY_ESCALATION_STEPS", () => {
  it("is soft-only with no urgent step and increasing delays", () => {
    expect(SOFT_LOW_ENERGY_ESCALATION_STEPS.length).toBeGreaterThan(0);
    for (const step of SOFT_LOW_ENERGY_ESCALATION_STEPS) {
      expect(step.intensity).toBe("soft");
      expect(step.channelKey).toBe("in_app");
    }
    const delays = SOFT_LOW_ENERGY_ESCALATION_STEPS.map((s) => s.delayMinutes);
    const sorted = [...delays].sort((a, b) => a - b);
    expect(delays).toEqual(sorted);
    // No cross-channel / urgent escalation ever.
    expect(
      SOFT_LOW_ENERGY_ESCALATION_STEPS.some((s) => s.intensity === "urgent"),
    ).toBe(false);
  });
});

describe("low-energy-support pack", () => {
  const record = lowEnergySupportPack.records[0];

  it("is offered but not auto-enabled", () => {
    expect(lowEnergySupportPack.defaultEnabled).toBe(false);
    expect(lowEnergySupportPack.key).toBe(LOW_ENERGY_SUPPORT_PACK_KEY);
  });

  it("fires flexibly inside the morning window (not a fixed time)", () => {
    expect(record?.trigger).toEqual({
      kind: "during_window",
      windowKey: "morning",
    });
  });

  it("is low priority and uses only the soft escalation ladder", () => {
    expect(record?.priority).toBe("low");
    expect(record?.escalation?.steps).toEqual([
      ...SOFT_LOW_ENERGY_ESCALATION_STEPS,
    ]);
  });

  it("verifies via a reply gate, never re-nags after engagement", () => {
    expect(record?.completionCheck?.kind).toBe("user_replied_within");
  });
});

describe("adhd-body-double pack", () => {
  const record = adhdBodyDoublePack.records[0];

  it("is offered but not auto-enabled", () => {
    expect(adhdBodyDoublePack.defaultEnabled).toBe(false);
    expect(adhdBodyDoublePack.key).toBe(ADHD_BODY_DOUBLE_PACK_KEY);
  });

  it("fires during the morning window with a light reply gate and soft ladder", () => {
    expect(record?.trigger).toEqual({
      kind: "during_window",
      windowKey: "morning",
    });
    expect(record?.completionCheck?.kind).toBe("user_replied_within");
    expect(record?.escalation?.steps).toEqual([
      ...SOFT_LOW_ENERGY_ESCALATION_STEPS,
    ]);
    expect(record?.priority).toBe("low");
  });
});

describe("object-permanence-watcher pack", () => {
  const record = objectPermanenceWatcherPack.records[0];

  it("is a non-owner-visible watcher folded into the morning anchor", () => {
    expect(objectPermanenceWatcherPack.key).toBe(
      OBJECT_PERMANENCE_WATCHER_PACK_KEY,
    );
    expect(record?.kind).toBe("watcher");
    expect(record?.ownerVisible).toBe(false);
    expect(record?.trigger).toEqual({
      kind: "relative_to_anchor",
      anchorKey: "wake.confirmed",
      offsetMinutes: 0,
    });
  });
});

describe("persona packs — content lint", () => {
  it("all persona pack prompts pass the default-pack content lint", () => {
    expect(lintPacks([...PERSONA_PACKS])).toEqual([]);
  });

  it("every persona pack record has a stable idempotency key", () => {
    const keys = PERSONA_PACKS.flatMap((p) =>
      p.records.map((r) => r.idempotencyKey),
    );
    expect(keys.every((k) => typeof k === "string" && k.length > 0)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

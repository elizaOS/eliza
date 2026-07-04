// Exercises LifeOps owner workflows, connector boundaries, and scheduled-task behavior.
import { describe, expect, it } from "vitest";
import {
  normalizeCadence,
  normalizeWindowNames,
} from "../src/lifeops/service-normalize-task.js";

/**
 * Scheduling-input normalization (#8795). Window names must validate against the
 * owner's window policy (reject unknown windows, dedupe), and cadence shaping
 * must canonicalize the per-kind fields — a bad window/cadence schedules a task
 * to fire at the wrong time or never.
 */

// biome-ignore lint/suspicious/noExplicitAny: minimal window-policy stand-in.
const policy: any = {
  windows: [{ name: "morning" }, { name: "evening" }],
};

describe("normalizeWindowNames", () => {
  it("validates against the policy and de-duplicates", () => {
    expect(
      normalizeWindowNames(["morning", "evening", "morning"], "w", policy),
    ).toEqual(["morning", "evening"]);
  });

  it("rejects empty / non-array / unknown windows", () => {
    expect(() => normalizeWindowNames([], "w", policy)).toThrow();
    expect(() => normalizeWindowNames("morning", "w", policy)).toThrow();
    expect(() => normalizeWindowNames(["midnight"], "w", policy)).toThrow(
      /unknown window/,
    );
  });
});

describe("normalizeCadence", () => {
  it("canonicalizes a once cadence ISO date", () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal cadence input.
    const out = normalizeCadence(
      { kind: "once", dueAt: "2026-06-23T00:00:00Z" } as any,
      policy,
    );
    expect(out).toMatchObject({
      kind: "once",
      dueAt: "2026-06-23T00:00:00.000Z",
    });
  });

  it("validates a daily cadence's windows against the policy", () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal cadence input.
    const out = normalizeCadence(
      { kind: "daily", windows: ["morning"] } as any,
      policy,
    );
    expect(out).toMatchObject({ kind: "daily", windows: ["morning"] });
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: minimal cadence input.
      normalizeCadence({ kind: "daily", windows: ["midnight"] } as any, policy),
    ).toThrow();
  });
});

/**
 * Covers the pure selectors and tone mappers behind the detail-extension
 * surfaces.
 *
 * `selectLatestRunForApp` decides which run the detail pane describes, and its
 * ordering key is the newest of two ISO strings that arrive from an API row —
 * either can be absent or unparseable, so a malformed stamp must not be able to
 * promote a stale run to the top of the list.
 *
 * The tone mappers are ordered checks over free-form status text, so the
 * precedence between them is a real contract rather than an accident.
 *
 * Pure functions — no React, no API.
 */
import { describe, expect, it } from "vitest";

import type { AppRunSummary } from "../../../api";
import {
  formatDetailTimestamp,
  selectLatestRunForApp,
  toneForHealthState,
  toneForStatusText,
  toneForViewerAttachment,
} from "./surface.helpers.ts";

const run = (
  id: string,
  appName: string,
  updatedAt?: string | null,
  startedAt?: string | null,
): AppRunSummary => ({ id, appName, updatedAt, startedAt }) as AppRunSummary;

const ids = (runs: AppRunSummary[]) => runs.map((entry) => entry.id);

describe("selectLatestRunForApp", () => {
  it("returns nothing for absent or non-array input", () => {
    expect(selectLatestRunForApp("app", null)).toEqual({
      run: null,
      matchingRuns: [],
    });
    expect(selectLatestRunForApp("app", undefined).run).toBeNull();
    expect(
      selectLatestRunForApp("app", "nope" as unknown as AppRunSummary[]).run,
    ).toBeNull();
  });

  it("keeps only runs for the requested app", () => {
    const selected = selectLatestRunForApp("mine", [
      run("a", "mine", "2026-01-01T00:00:00Z"),
      run("b", "other", "2026-05-01T00:00:00Z"),
    ]);
    expect(ids(selected.matchingRuns)).toEqual(["a"]);
    expect(selected.run?.id).toBe("a");
  });

  it("returns null when no run matches", () => {
    expect(selectLatestRunForApp("mine", [run("b", "other")]).run).toBeNull();
  });

  it("picks the newest run, newest first", () => {
    const selected = selectLatestRunForApp("mine", [
      run("old", "mine", "2026-01-01T00:00:00Z"),
      run("new", "mine", "2026-05-01T00:00:00Z"),
      run("mid", "mine", "2026-03-01T00:00:00Z"),
    ]);
    expect(selected.run?.id).toBe("new");
    expect(ids(selected.matchingRuns)).toEqual(["new", "mid", "old"]);
  });

  it("uses the newer of updatedAt and startedAt", () => {
    const selected = selectLatestRunForApp("mine", [
      run("byUpdated", "mine", "2026-05-01T00:00:00Z", "2026-01-01T00:00:00Z"),
      run("byStarted", "mine", null, "2026-03-01T00:00:00Z"),
    ]);
    expect(selected.run?.id).toBe("byUpdated");
  });

  it("does not let a run with no usable timestamps outrank a dated one", () => {
    const selected = selectLatestRunForApp("mine", [
      run("undated", "mine", null, null),
      run("dated", "mine", "2026-05-01T00:00:00Z"),
    ]);
    expect(selected.run?.id).toBe("dated");
  });

  it("does not let an unparseable timestamp outrank a dated run", () => {
    const selected = selectLatestRunForApp("mine", [
      run("bad", "mine", "not-a-date", "also-bad"),
      run("dated", "mine", "2026-05-01T00:00:00Z"),
    ]);
    expect(selected.run?.id).toBe("dated");
  });

  it("does not mutate the caller's array", () => {
    const runs = [
      run("old", "mine", "2026-01-01T00:00:00Z"),
      run("new", "mine", "2026-05-01T00:00:00Z"),
    ];
    selectLatestRunForApp("mine", runs);
    expect(ids(runs)).toEqual(["old", "new"]);
  });
});

describe("formatDetailTimestamp", () => {
  it("falls back for absent, blank, and unparseable values", () => {
    for (const value of [
      null,
      undefined,
      "",
      "   ",
      "not-a-date",
      Number.NaN,
    ]) {
      expect(formatDetailTimestamp(value)).toBe("Not yet verified");
    }
  });

  it("formats a parseable ISO string as something other than the fallback", () => {
    const formatted = formatDetailTimestamp("2026-05-01T00:00:00.000Z");
    expect(formatted).not.toBe("Not yet verified");
    expect(formatted.length).toBeGreaterThan(0);
  });

  it("formats an epoch number, including 0", () => {
    expect(formatDetailTimestamp(0)).not.toBe("Not yet verified");
    expect(formatDetailTimestamp(1_800_000_000_000)).not.toBe(
      "Not yet verified",
    );
  });

  it("agrees between a timestamp and its ISO string", () => {
    const ms = 1_800_000_000_000;
    expect(formatDetailTimestamp(ms)).toBe(
      formatDetailTimestamp(new Date(ms).toISOString()),
    );
  });
});

describe("tone mappers", () => {
  it("maps each health state, defaulting to neutral", () => {
    expect(toneForHealthState("healthy")).toBe("success");
    expect(toneForHealthState("degraded")).toBe("warn");
    expect(toneForHealthState("offline")).toBe("danger");
    expect(toneForHealthState(null)).toBe("neutral");
    expect(toneForHealthState(undefined)).toBe("neutral");
    expect(toneForHealthState("unknown" as never)).toBe("neutral");
  });

  it("maps viewer attachment, defaulting to neutral", () => {
    expect(toneForViewerAttachment("attached")).toBe("success");
    expect(toneForViewerAttachment("detached")).toBe("warn");
    expect(toneForViewerAttachment(null)).toBe("neutral");
    expect(toneForViewerAttachment("other" as never)).toBe("neutral");
  });

  it("matches status text case-insensitively on a substring", () => {
    expect(toneForStatusText("RUNNING")).toBe("success");
    expect(toneForStatusText("container is ready")).toBe("success");
    expect(toneForStatusText("Waiting for port")).toBe("warn");
    expect(toneForStatusText("build FAILED")).toBe("danger");
    expect(toneForStatusText("fatal error")).toBe("danger");
  });

  it("returns neutral for empty or unrecognized status text", () => {
    expect(toneForStatusText(null)).toBe("neutral");
    expect(toneForStatusText(undefined)).toBe("neutral");
    expect(toneForStatusText("")).toBe("neutral");
    expect(toneForStatusText("provisioning")).toBe("neutral");
  });

  it("resolves an overlapping status by the documented check order", () => {
    // "running"/"ready" is checked first, then warn, then error — so a status
    // that mentions both reports the earlier tone.
    expect(toneForStatusText("running with errors")).toBe("success");
    expect(toneForStatusText("waiting after error")).toBe("warn");
  });
});

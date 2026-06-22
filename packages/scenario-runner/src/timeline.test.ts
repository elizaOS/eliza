/**
 * writeTimeline (audit Wave 1.1) — the ordered, scrubbable run timeline artifact
 * so a reviewer can align a video / trajectory scrubber to scenario → turn →
 * action → finalCheck boundaries. Previously the reporter emitted only the
 * JSON report + run viewer; there was no first-class timeline.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAggregate, writeTimeline } from "./reporter.ts";
import type { ScenarioReport, TurnReport } from "./types.ts";

function turn(
  name: string,
  durationMs: number,
  actions: string[] = [],
): TurnReport {
  return {
    name,
    kind: "action",
    responseText: "",
    actionsCalled: actions.map((actionName) => ({ actionName })),
    durationMs,
    failedAssertions: [],
  };
}

function scenario(
  id: string,
  durationMs: number,
  turns: TurnReport[],
): ScenarioReport {
  return {
    id,
    title: `Title ${id}`,
    domain: "coding",
    tags: [],
    status: "passed",
    durationMs,
    turns,
    finalChecks: [
      {
        label: "spawned",
        type: "subAgentSpawned",
        status: "passed",
        detail: "ok",
      },
    ],
    actionsCalled: [],
    failedAssertions: [],
    providerName: null,
  };
}

describe("writeTimeline", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "timeline-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("emits ordered, cumulative scenario→turn→action→finalCheck events + writes JSON", () => {
    const report = buildAggregate(
      [
        scenario("s1", 300, [
          turn("t1", 100, ["TASKS_CREATE", "FILE"]),
          turn("t2", 200, []),
        ]),
        scenario("s2", 150, [turn("t1", 150, [])]),
      ],
      null,
      "2026-06-22T00:00:00.000Z",
      "2026-06-22T00:01:00.000Z",
      "run-x",
    );
    const file = join(dir, "timeline.json");
    const events = writeTimeline(report, file);

    // monotonic seq
    expect(events.map((e) => e.seq)).toEqual(events.map((_e, i) => i));

    // scenario s1 starts at 0; s2 starts where s1 ended (300)
    const s1 = events.find(
      (e) => e.kind === "scenario" && e.scenarioId === "s1",
    );
    const s2 = events.find(
      (e) => e.kind === "scenario" && e.scenarioId === "s2",
    );
    expect(s1?.startMs).toBe(0);
    expect(s1?.endMs).toBe(300);
    expect(s2?.startMs).toBe(300);
    expect(s2?.endMs).toBe(450);

    // turns within s1 are sequential: t1 [0,100], t2 [100,300]
    const s1turns = events.filter(
      (e) => e.kind === "turn" && e.scenarioId === "s1",
    );
    expect(s1turns[0]?.startMs).toBe(0);
    expect(s1turns[0]?.endMs).toBe(100);
    expect(s1turns[1]?.startMs).toBe(100);
    expect(s1turns[1]?.endMs).toBe(300);

    // two actions in t1 are distributed across [0,100]
    const acts = events.filter(
      (e) => e.kind === "action" && e.scenarioId === "s1",
    );
    expect(acts.map((a) => a.name)).toEqual(["TASKS_CREATE", "FILE"]);
    expect(acts[0]?.startMs).toBe(0);
    expect(acts[1]?.startMs).toBe(50);
    expect(acts[1]?.endMs).toBe(100);

    // finalCheck is a point event at the scenario end
    const fc = events.find(
      (e) => e.kind === "finalCheck" && e.scenarioId === "s1",
    );
    expect(fc?.startMs).toBe(300);
    expect(fc?.endMs).toBe(300);
    expect(fc?.durationMs).toBe(0);

    // persisted artifact carries totalMs = end of last scenario
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.runId).toBe("run-x");
    expect(onDisk.totalMs).toBe(450);
    expect(onDisk.events.length).toBe(events.length);
  });

  it("handles an empty report", () => {
    const report = buildAggregate([], null, "a", "b", "run-empty");
    const events = writeTimeline(report, join(dir, "t.json"));
    expect(events).toEqual([]);
  });
});

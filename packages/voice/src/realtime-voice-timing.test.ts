import { describe, expect, it } from "vitest";
import {
  createRealtimeVoiceTiming,
  REALTIME_TIMING_LIMIT,
  type RealtimeCancellationCause,
  sanitizeRealtimeTiming,
} from "./realtime-voice-timing";

// Diagnostic lifecycle/privacy checks only; not microphone or provider evidence.
function fixture() {
  let stored: string | null = null;
  let writes = 0;
  let resolutions = 0;
  let nextId = 0;
  const timing = createRealtimeVoiceTiming({
    storageKey: "test:realtime:v1",
    storage: () => {
      resolutions++;
      return {
        getItem: () => stored,
        setItem: (_key, value) => {
          writes++;
          stored = value;
        },
      };
    },
    now: () => 100,
    epoch: () => 1000,
    id: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`,
  });
  return {
    timing,
    rows: () => JSON.parse(timing.exportJson()).records,
    accesses: () => ({ writes, resolutions }),
  };
}

const causes = [
  "foreground-check-failed",
  "owned-navigation-unconfirmed",
  "renderer-closed",
  "binding-check-failed",
  "notes-left-unowned",
  "shell-navigation-unowned",
  "component-unmounted",
  "document-hidden",
  "page-hidden",
  "connection-opened",
  "account-changed",
] as const satisfies readonly RealtimeCancellationCause[];

describe("realtime cancellation diagnostics", () => {
  it.each(causes)("round-trips the fixed cancellation cause %s", (cause) => {
    const f = fixture();
    const handle = f.timing.start("direct-cartesia");
    handle.acceptedFinal("private-trace-must-not-persist");
    handle.noteCancellation(cause);
    handle.stop();
    expect(
      f
        .rows()
        .map((row: { cancellationCause?: string }) => row.cancellationCause),
    ).toEqual([cause, cause]);
    expect(f.timing.exportJson()).not.toContain(
      "private-trace-must-not-persist",
    );
  });

  it("keeps the first valid cause in memory without storage access until existing stop writes", () => {
    const f = fixture();
    const handle = f.timing.start("direct-cartesia");
    handle.acceptedFinal("trace");
    const before = f.accesses();
    handle.noteCancellation("not-a-cause" as RealtimeCancellationCause);
    handle.noteCancellation("document-hidden");
    handle.noteCancellation("page-hidden");
    expect(f.accesses()).toEqual(before);
    expect(f.rows().every((row: object) => !("cancellationCause" in row))).toBe(
      true,
    );
    handle.stop();
    expect(
      f
        .rows()
        .map((row: { cancellationCause?: string }) => row.cancellationCause),
    ).toEqual(["document-hidden", "document-hidden"]);
  });

  it("does not reopen or annotate a stopped handle or its replacement", () => {
    const f = fixture();
    const old = f.timing.start("direct-cartesia");
    old.acceptedFinal("old");
    old.stop();
    const before = f.rows();
    const current = f.timing.start("direct-cartesia");
    current.acceptedFinal("new");
    const accesses = f.accesses();
    old.noteCancellation("component-unmounted");
    expect(f.accesses()).toEqual(accesses);
    expect(f.rows().slice(0, 2)).toEqual(before);
    expect(f.rows().every((row: object) => !("cancellationCause" in row))).toBe(
      true,
    );
    current.noteCancellation("account-changed");
    current.stop();
    expect(f.rows().slice(0, 2)).toEqual(before);
    expect(
      f
        .rows()
        .slice(2)
        .map((row: { cancellationCause?: string }) => row.cancellationCause),
    ).toEqual(["account-changed", "account-changed"]);
  });

  it("does not retrofit rows after error closes the collector", () => {
    const f = fixture();
    const handle = f.timing.start("direct-cartesia");
    handle.acceptedFinal("trace");
    handle.error();
    const before = f.rows();
    const accesses = f.accesses();
    handle.noteCancellation("renderer-closed");
    expect(f.accesses()).toEqual(accesses);
    expect(f.rows()).toEqual(before);
    expect(
      before.every((row: { outcome: string }) => row.outcome === "error"),
    ).toBe(true);
  });

  it.each(["reply_complete", "interrupted", "fatal-error"])(
    "preserves the prior %s turn while the active session may record its own cause",
    (control) => {
      const f = fixture();
      const handle = f.timing.start("direct-cartesia");
      handle.acceptedFinal("trace");
      handle.control(control, "trace");
      const prior = f
        .rows()
        .find((row: { kind: string }) => row.kind === "turn");
      handle.noteCancellation("page-hidden");
      handle.stop();
      expect(
        f.rows().find((row: { kind: string }) => row.kind === "turn"),
      ).toEqual(prior);
      expect(
        f.rows().find((row: { kind: string }) => row.kind === "session")
          .cancellationCause,
      ).toBe("page-hidden");
    },
  );

  it("does not annotate a superseded turn or copy a cause into a future turn", () => {
    const f = fixture();
    const handle = f.timing.start("direct-cartesia");
    handle.acceptedFinal("old");
    handle.acceptedFinal("current");
    const superseded = f
      .rows()
      .find((row: { outcome: string }) => row.outcome === "superseded");
    handle.noteCancellation("notes-left-unowned");
    handle.acceptedFinal("future");
    handle.stop();
    const rows = f.rows();
    expect(
      rows.find((row: { id: string }) => row.id === superseded.id),
    ).toEqual(superseded);
    expect(rows.at(-1).cancellationCause).toBeUndefined();
    expect(
      rows
        .filter((row: { cancellationCause?: string }) => row.cancellationCause)
        .map((row: { kind: string }) => row.kind),
    ).toEqual(["session", "turn"]);
  });

  it("persists a pending cause through existing error writes without another diagnostic write", () => {
    const f = fixture();
    const handle = f.timing.start("direct-cartesia");
    handle.acceptedFinal("trace");
    handle.noteCancellation("binding-check-failed");
    handle.error();
    expect(
      f
        .rows()
        .map((row: { outcome: string; cancellationCause?: string }) => [
          row.outcome,
          row.cancellationCause,
        ]),
    ).toEqual([
      ["error", "binding-check-failed"],
      ["error", "binding-check-failed"],
    ]);
  });

  it("keeps legacy v1 rows valid and strips every non-allowlisted cancellation value", () => {
    const f = fixture();
    f.timing.start("direct-cartesia").stop();
    const legacy = JSON.parse(f.timing.exportJson());
    expect(sanitizeRealtimeTiming(JSON.stringify(legacy)).records).toEqual(
      legacy.records,
    );
    for (const cancellationCause of [
      "",
      "unknown",
      "raw error text",
      "user@example.test",
      1,
      true,
      null,
      [],
      {},
    ]) {
      const doc = {
        ...legacy,
        records: [{ ...legacy.records[0], cancellationCause }],
      };
      expect(sanitizeRealtimeTiming(JSON.stringify(doc)).records).toEqual(
        legacy.records,
      );
    }
  });

  it("retains the 200-row and 262144-byte caps with optional cancellation metadata", () => {
    const f = fixture();
    for (let i = 0; i < 201; i++) {
      const handle = f.timing.start("direct-cartesia");
      handle.noteCancellation("foreground-check-failed");
      handle.stop();
    }
    expect(f.rows()).toHaveLength(200);
    expect(
      new TextEncoder().encode(f.timing.exportJson()).byteLength,
    ).toBeLessThanOrEqual(REALTIME_TIMING_LIMIT);
    const oversized = JSON.stringify({
      ...JSON.parse(f.timing.exportJson()),
      padding: "☃".repeat(100000),
    });
    expect(sanitizeRealtimeTiming(oversized).records).toEqual([]);
  });
});

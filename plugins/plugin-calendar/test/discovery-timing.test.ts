/** Timing-only test: real method and timing helper, explicit I/O-free ports. */
import {
  type IAgentRuntime,
  InferenceTurnTimer,
  runWithInferenceTiming,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { CalendarService } from "../src/service/CalendarService.js";

function fixture(error?: Error) {
  const calls: string[] = [];
  // Avoid constructor/setGate: setGate starts a detached database sync bootstrap.
  // This test exercises the real discoverCalendars method, not lifecycle startup.
  const service = Object.create(CalendarService.prototype) as CalendarService;
  Object.assign(service, {
    runtime: {
      agentId: "timing-owner",
      reportError: () => {},
      getCache: () => {
        throw Error("Unexpected cache I/O");
      },
    } as unknown as IAgentRuntime,
    gate: {
      getGoogleConnectorAccounts: async () => {
        calls.push("google");
        if (error) throw error;
        return [];
      },
    },
    microsoftPort: {
      listAccounts: async () => {
        calls.push("microsoft");
        return [];
      },
    },
    managedCalendar: undefined,
    repo: {
      listIcsCalendarSources: () => {
        throw Error("Unexpected repository I/O");
      },
    },
  });
  return { service, calls };
}
const url = new URL("http://internal.local/api/calendar");
const request = { side: "agent" as const }; // No owner Eliza/Apple/ICS/managed catalogs; no preference SQL.
describe("Calendar discovery timing-only spans", () => {
  it("preserves the empty agent catalog and records selected existing waits", async () => {
    const { service, calls } = fixture();
    const expected = await service.discoverCalendars(url, request);
    const timer = new InferenceTurnTimer({
      turnId: "diagnostic-turn",
      label: "test",
    });
    const actual = await runWithInferenceTiming(timer, () =>
      service.discoverCalendars(url, request),
    );
    expect(actual).toEqual(expected);
    expect(calls).toEqual(["google", "microsoft", "google", "microsoft"]);
    const spans = timer
      .summary()
      .spans.filter((s) => s.name.startsWith("calendar:discovery:"));
    expect(spans.map((s) => s.name)).toEqual([
      "calendar:discovery:google-accounts",
      "calendar:discovery:microsoft-accounts",
      "calendar:discovery:preferences",
    ]);
    for (const span of spans) {
      expect(span.meta ?? {}).toEqual({});
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
  it("preserves exact rejection identity and closes its span without private text", async () => {
    const failure = Error("private source failure");
    const { service, calls } = fixture(failure);
    const timer = new InferenceTurnTimer({
      turnId: "diagnostic-failure",
      label: "test",
    });
    await expect(
      runWithInferenceTiming(timer, () =>
        service.discoverCalendars(url, request),
      ),
    ).rejects.toBe(failure);
    expect(calls).toEqual(["google"]);
    const spans = timer
      .summary()
      .spans.filter((s) => s.name.startsWith("calendar:discovery:"));
    expect(spans.map((s) => s.name)).toEqual([
      "calendar:discovery:google-accounts",
    ]);
    expect(JSON.stringify(spans)).not.toContain("private source failure");
  });
});

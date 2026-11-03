/** Discovery probe scheduling: real method, held I/O-free ports, no SQL. */
import type { LifeOpsConnectorGrant } from "@elizaos/contracts";
import type { IAgentRuntime } from "@elizaos/core";
import { afterAll, describe, expect, it, vi } from "vitest";
import { __testing } from "../src/apple-calendar.js";
import { CalendarService } from "../src/service/CalendarService.js";
import { managedCalendarPlaceholder } from "../src/service/managed-calendar-read.js";

const preferenceWrites = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/service/feed-preferences.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/service/feed-preferences.js")>();
  return {
    ...actual,
    // Preference rows are outside this test: every listed source is included.
    ensureCalendarFeedIncludes: async (
      _runtime: IAgentRuntime,
      identifiers: Parameters<typeof actual.calendarFeedPreferenceKey>[0][],
    ) => {
      preferenceWrites.count += 1;
      const keys = identifiers.map(actual.calendarFeedPreferenceKey);
      return {
        calendarFeedIncludes: Object.fromEntries(keys.map((k) => [k, true])),
        calendarFeedVersions: Object.fromEntries(keys.map((k) => [k, 0])),
        updatedAt: null,
      };
    },
  };
});
afterAll(() => __testing.setNativeCalendarBridgeForTest(undefined as never));

const probes = ["google", "microsoft", "apple", "ics", "managed"] as const;
type Probe = (typeof probes)[number];
type Failures = Partial<
  Record<Probe | "googleList" | "microsoftList" | "appleNative", Error>
>;
const url = new URL("http://internal.local/api/calendar");
const grant = {
  id: "google-grant",
  connectorAccountId: "google-account",
  side: "owner",
  mode: "local",
  capabilities: ["google.calendar.read"],
} as LifeOpsConnectorGrant;
const microsoftAccount = {
  account: { id: "microsoft-account" },
  grant: {
    id: "microsoft-grant",
    side: "owner",
    capabilities: ["microsoft.calendar.read_basic"],
  },
  accountKind: "personal",
};
const managed = {
  ...managedCalendarPlaceholder(`alpha-google:${"b".repeat(64)}`),
  calendarId: "primary",
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function fixture(failures: Failures = {}) {
  const started: Probe[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const gates = new Map(
    probes.map((name) => {
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return [name, { open, opened }] as const;
    }),
  );
  // Each probe's first call waits for its own release; the result or failure
  // is chosen up front, so release order alone decides settle order.
  const hold = async <T>(name: Probe, value: () => T): Promise<T> => {
    started.push(name);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await gates.get(name)?.opened;
      const failure = failures[name];
      if (failure) throw failure;
      return value();
    } finally {
      inFlight -= 1;
    }
  };
  __testing.setNativeCalendarBridgeForTest({
    platform: "darwin",
    checkPermissions: async () => ({ calendar: "granted", canRequest: false }),
    listCalendars: () =>
      hold("apple", () =>
        failures.appleNative
          ? { ok: false, message: failures.appleNative.message }
          : { ok: true, calendars: [{ calendarId: "apple-cal" }] },
      ),
  } as never);
  const reportError = vi.fn();
  const service = Object.create(CalendarService.prototype) as CalendarService;
  Object.assign(service, {
    runtime: {
      agentId: "discovery-owner",
      reportError,
      getService: (name: string) =>
        name === "google"
          ? {
              listCalendars: async () => {
                if (failures.googleList) throw failures.googleList;
                return [
                  {
                    calendarId: "google-cal",
                    summary: "Google",
                    description: null,
                    primary: true,
                    accessRole: "owner",
                    backgroundColor: null,
                    foregroundColor: null,
                    timeZone: null,
                    selected: true,
                  },
                ];
              },
            }
          : null,
    } as unknown as IAgentRuntime,
    gate: {
      getGoogleConnectorAccounts: () => hold("google", () => [{ grant }]),
    },
    microsoftPort: {
      listAccounts: () => hold("microsoft", () => [microsoftAccount]),
      listCalendars: async () => {
        if (failures.microsoftList) throw failures.microsoftList;
        return [
          {
            id: "microsoft-cal",
            name: "Microsoft",
            ownerAddress: null,
            isDefault: true,
            canEdit: false,
            color: null,
            hexColor: null,
          },
        ];
      },
    },
    repo: {
      listIcsCalendarSources: () =>
        hold("ics", () => [
          { id: "ics-source", name: "ICS", origin: "example", enabled: true },
        ]),
    },
    managedCalendar: {
      acceptsGrantId: () => true,
      owns: (calendar: { grantId: string }) =>
        calendar.grantId === managed.grantId,
      sources: () => hold("managed", () => [managed]),
    },
  });
  const release = async (...names: Probe[]) => {
    for (const name of names) {
      gates.get(name)?.open();
      await tick();
    }
  };
  return {
    service,
    started,
    release,
    reportError,
    maxInFlight: () => maxInFlight,
  };
}

const reversed = [...probes].reverse();
const sources = (rows: { provider: string; calendarId: string }[]) =>
  rows.map((row) => `${row.provider}:${row.calendarId}`);

describe("calendar discovery probes", () => {
  it("starts every source probe before an earlier one settles", async () => {
    const f = fixture();
    const discovery = f.service.discoverCalendars(url);
    await tick();
    // Start order inside the wave follows each port's own awaits.
    expect([...f.started].sort()).toEqual([...probes].sort());
    expect(f.maxInFlight()).toBe(probes.length);
    await f.release(...reversed);
    await discovery;
    expect(f.started).toHaveLength(probes.length);
  });

  it.each([
    ["local mode", { mode: "local" }, ["apple", "google", "ics", "microsoft"]],
    ["managed mode", { mode: "cloud_managed" }, ["google", "managed"]],
    ["agent side", { side: "agent" }, ["google", "microsoft"]],
  ] as const)(
    "probes only the sources a request selects: %s",
    async (_label, request, expected) => {
      const f = fixture();
      const discovery = f.service.discoverCalendars(url, request);
      await f.release(...reversed);
      await discovery;
      expect([...f.started].sort()).toEqual(expected);
    },
  );

  it("keeps catalog order when probes settle in reverse", async () => {
    preferenceWrites.count = 0;
    const f = fixture();
    const discovery = f.service.discoverCalendars(url);
    await f.release(...reversed);
    const result = await discovery;
    expect(sources(result.calendars)).toEqual([
      "eliza:primary",
      "google:google-cal",
      "microsoft:microsoft-cal",
      "apple_calendar:apple-cal",
      "ics:ics-source",
      "google:primary",
    ]);
    expect(result.failures).toEqual([]);
    expect(f.maxInFlight()).toBeLessThanOrEqual(probes.length);
    expect(preferenceWrites.count).toBe(1);
  });

  it("keeps handled failures in probe order", async () => {
    const f = fixture({
      googleList: Error("google list"),
      microsoft: Error("microsoft accounts"),
      appleNative: Error("apple native"),
      managed: Error("managed sources"),
    });
    const discovery = f.service.discoverCalendars(url);
    await f.release(...reversed);
    const result = await discovery;
    expect(sources(result.calendars)).toEqual([
      "eliza:primary",
      "ics:ics-source",
    ]);
    expect(
      result.failures.map((failure) => [
        failure.key.provider,
        failure.key.grantId,
        failure.error?.message,
      ]),
    ).toEqual([
      ["google", "google-grant", "google list"],
      ["microsoft", "microsoft-discovery", "microsoft accounts"],
      ["apple_calendar", "apple-calendar", "apple native"],
      ["google", "alpha-google:broker", "managed sources"],
    ]);
    expect(f.reportError).toHaveBeenCalledTimes(3);
  });

  it.each([
    [
      "Google accounts over later uncaught probes",
      { google: Error("google"), apple: Error("apple"), ics: Error("ics") },
      "google",
    ],
    ["Apple over ICS", { apple: Error("apple"), ics: Error("ics") }, "apple"],
    [
      "ICS over a handled managed failure",
      { ics: Error("ics"), managed: Error("managed") },
      "ics",
    ],
  ] as const)(
    "surfaces the first uncaught failure in probe order: %s",
    async (_label, failures, expected) => {
      preferenceWrites.count = 0;
      const f = fixture(failures);
      const rejected = expect(f.service.discoverCalendars(url)).rejects.toBe(
        failures[expected as Probe],
      );
      await f.release(...reversed);
      await rejected;
      expect(preferenceWrites.count).toBe(0);
    },
  );

  it("rejects with the request's abort reason and writes no preference", async () => {
    preferenceWrites.count = 0;
    const f = fixture();
    const controller = new AbortController();
    const reason = Error("request ended");
    const rejected = expect(
      f.service.discoverCalendars(url, {}, controller.signal),
    ).rejects.toBe(reason);
    controller.abort(reason);
    await f.release(...reversed);
    await rejected;
    expect(preferenceWrites.count).toBe(0);
  });

  it("lets an earlier uncaught failure win over an aborted request", async () => {
    const failure = Error("apple");
    const f = fixture({ apple: failure });
    const controller = new AbortController();
    const rejected = expect(
      f.service.discoverCalendars(url, {}, controller.signal),
    ).rejects.toBe(failure);
    controller.abort(Error("request ended"));
    await f.release(...reversed);
    await rejected;
  });
});

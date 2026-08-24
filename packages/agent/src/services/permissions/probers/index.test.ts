/**
 * Unit coverage for the central prober index module. Drives the real index
 * with sentinel probers substituted for every dependency module, so declared
 * composition order, native-platform spread placement and flattening,
 * PROBERS_BY_ID indexing (duplicate-id last-write-wins, unknown and nullish
 * lookups), named-export identity, and import-time side-effect freedom are
 * asserted against independently controlled fixtures rather than reconstructed
 * from the module's own output.
 */
import { describe, expect, it, vi } from "vitest";

import type { PermissionId } from "../contracts.ts";
import { accessibilityProber } from "./accessibility.ts";
import { automationProber } from "./automation.ts";
import { calendarProber } from "./calendar.ts";
import { cameraProber } from "./camera.ts";
import { contactsProber } from "./contacts.ts";
import { fullDiskProber } from "./full-disk.ts";
import { healthProber } from "./health.ts";
import { ALL_PROBERS, PROBERS_BY_ID } from "./index.ts";
import { locationProber } from "./location.ts";
import { microphoneProber } from "./microphone.ts";
import { nativePlatformProbers } from "./native-platform.ts";
import { notesProber } from "./notes.ts";
import { notificationsProber } from "./notifications.ts";
import { remindersProber } from "./reminders.ts";
import { screenRecordingProber } from "./screen-recording.ts";
import { screentimeProber } from "./screentime.ts";
import { shellProber } from "./shell.ts";

vi.mock("./accessibility.ts", () => ({
  accessibilityProber: {
    id: "accessibility",
    check: vi.fn(),
    request: vi.fn(),
  },
}));
vi.mock("./automation.ts", () => ({
  automationProber: { id: "automation", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./calendar.ts", () => ({
  calendarProber: { id: "calendar", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./camera.ts", () => ({
  cameraProber: { id: "camera", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./contacts.ts", () => ({
  contactsProber: { id: "contacts", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./full-disk.ts", () => ({
  fullDiskProber: { id: "full-disk", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./health.ts", () => ({
  healthProber: { id: "health", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./location.ts", () => ({
  locationProber: { id: "location", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./microphone.ts", () => ({
  microphoneProber: { id: "microphone", check: vi.fn(), request: vi.fn() },
}));
// Two sentinels deliberately share one id so the Map construction's
// last-write-wins behaviour is observable through the public index exports.
vi.mock("./native-platform.ts", () => ({
  nativePlatformProbers: [
    {
      id: "speech-recognition",
      check: vi.fn(),
      request: vi.fn(),
    },
    {
      id: "speech-recognition",
      check: vi.fn(),
      request: vi.fn(),
    },
  ],
}));
vi.mock("./notes.ts", () => ({
  notesProber: { id: "notes", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./notifications.ts", () => ({
  notificationsProber: {
    id: "notifications",
    check: vi.fn(),
    request: vi.fn(),
  },
}));
vi.mock("./reminders.ts", () => ({
  remindersProber: { id: "reminders", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./screen-recording.ts", () => ({
  screenRecordingProber: {
    id: "screen-recording",
    check: vi.fn(),
    request: vi.fn(),
  },
}));
vi.mock("./screentime.ts", () => ({
  screentimeProber: { id: "screentime", check: vi.fn(), request: vi.fn() },
}));
vi.mock("./shell.ts", () => ({
  shellProber: { id: "shell", check: vi.fn(), request: vi.fn() },
}));

describe("ALL_PROBERS composition", () => {
  it("composes every prober exactly once in declaration order with natives between microphone and notes", () => {
    const expected = [
      accessibilityProber,
      automationProber,
      calendarProber,
      cameraProber,
      contactsProber,
      fullDiskProber,
      healthProber,
      locationProber,
      microphoneProber,
      ...nativePlatformProbers,
      notesProber,
      notificationsProber,
      remindersProber,
      screenRecordingProber,
      screentimeProber,
      shellProber,
    ];
    expect(ALL_PROBERS).toHaveLength(expected.length);
    for (let slot = 0; slot < expected.length; slot += 1) {
      expect(ALL_PROBERS[slot]).toBe(expected[slot]);
    }
  });

  it("flattens nativePlatformProbers into entries instead of nesting the array", () => {
    const micIndex = ALL_PROBERS.indexOf(microphoneProber);
    const notesIndex = ALL_PROBERS.indexOf(notesProber);
    const segment = ALL_PROBERS.slice(micIndex + 1, notesIndex);
    expect(segment).toEqual(nativePlatformProbers);
    for (let slot = 0; slot < segment.length; slot += 1) {
      expect(segment[slot]).toBe(nativePlatformProbers[slot]);
    }
    expect(ALL_PROBERS.every((entry) => typeof entry.id === "string")).toBe(
      true,
    );
  });
});

describe("PROBERS_BY_ID indexing", () => {
  it("resolves the later entry for a duplicated id (Map last-write-wins)", () => {
    const [firstNative, secondNative] = nativePlatformProbers;
    expect(firstNative?.id).toBe("speech-recognition");
    expect(secondNative?.id).toBe("speech-recognition");
    expect(PROBERS_BY_ID.get("speech-recognition")).toBe(secondNative);
    expect(PROBERS_BY_ID.get("speech-recognition")).not.toBe(firstNative);
  });

  it("indexes one entry per unique id", () => {
    const uniqueIds = new Set(ALL_PROBERS.map((prober) => prober.id));
    expect(PROBERS_BY_ID.size).toBe(uniqueIds.size);
    expect(PROBERS_BY_ID.size).toBe(ALL_PROBERS.length - 1);
  });

  it("resolves every named export to its identical instance", () => {
    const named = [
      accessibilityProber,
      automationProber,
      calendarProber,
      cameraProber,
      contactsProber,
      fullDiskProber,
      healthProber,
      locationProber,
      microphoneProber,
      notesProber,
      notificationsProber,
      remindersProber,
      screenRecordingProber,
      screentimeProber,
      shellProber,
    ];
    for (const prober of named) {
      expect(PROBERS_BY_ID.get(prober.id)).toBe(prober);
      expect(ALL_PROBERS.indexOf(prober)).toBe(ALL_PROBERS.lastIndexOf(prober));
      expect(ALL_PROBERS).toContain(prober);
    }
  });

  it("returns undefined for an unregistered id without throwing", () => {
    // website-blocking is a valid plugin-provided id that the central index
    // deliberately never enumerates (#12660).
    const missing = "website-blocking" as PermissionId;
    expect(PROBERS_BY_ID.get(missing)).toBeUndefined();
    expect(PROBERS_BY_ID.has(missing)).toBe(false);
    expect(
      PROBERS_BY_ID.get(undefined as unknown as PermissionId),
    ).toBeUndefined();
    expect(PROBERS_BY_ID.has(null as unknown as PermissionId)).toBe(false);
  });
});

describe("import side effects", () => {
  it("never eagerly invokes check() or request() on any composed prober", () => {
    const spies = [...ALL_PROBERS].flatMap((prober) => [
      prober.check,
      prober.request,
    ]);
    expect(spies.length).toBeGreaterThan(0);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("spreads an empty native platform list so notes follows microphone directly", async () => {
    vi.resetModules();
    vi.doMock("./native-platform.ts", () => ({ nativePlatformProbers: [] }));
    try {
      const fresh = await import("./index.ts");
      const ids = fresh.ALL_PROBERS.map((prober) => prober.id);
      expect(ids).toEqual([
        "accessibility",
        "automation",
        "calendar",
        "camera",
        "contacts",
        "full-disk",
        "health",
        "location",
        "microphone",
        "notes",
        "notifications",
        "reminders",
        "screen-recording",
        "screentime",
        "shell",
      ]);
      expect(fresh.ALL_PROBERS).toHaveLength(15);
      expect(fresh.PROBERS_BY_ID.size).toBe(15);
    } finally {
      vi.doUnmock("./native-platform.ts");
      vi.resetModules();
    }
  });
});

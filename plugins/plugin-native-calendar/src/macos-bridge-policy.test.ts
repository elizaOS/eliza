import { describe, expect, it } from "vitest";
import {
  APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME,
  appleCalendarMacosBridgeCandidates,
} from "./macos-bridge-policy";

describe("Apple Calendar macOS bridge policy", () => {
  it("keeps env, packaged, and local EventKit dylib candidates available", () => {
    const candidates = appleCalendarMacosBridgeCandidates({
      envDylibPath: "/tmp/custom-calendar.dylib",
    });

    expect(candidates).toEqual([
      {
        label: "ELIZA_NATIVE_PERMISSIONS_DYLIB",
        path: "/tmp/custom-calendar.dylib",
      },
      {
        label: "packaged Apple permissions bridge",
        path: `../../../../../../../${APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME}`,
      },
      {
        label: "packaged Apple permissions bridge",
        path: `../../../../../../${APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME}`,
      },
      {
        label: "local Apple permissions bridge",
        path: `../../../../packages/app-core/platforms/electrobun/src/${APPLE_CALENDAR_MACOS_BRIDGE_DYLIB_BASENAME}`,
      },
    ]);
  });

  it("omits the env candidate when no override is configured", () => {
    const labels = appleCalendarMacosBridgeCandidates().map(
      (candidate) => candidate.label,
    );

    expect(labels).not.toContain("ELIZA_NATIVE_PERMISSIONS_DYLIB");
  });
});

import { describe, expect, it } from "vitest";
import {
  APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME,
  appleRemindersMacosBridgeCandidates,
} from "./macos-bridge-policy.js";

describe("Apple Reminders macOS bridge policy", () => {
  it("keeps env, packaged, and local EventKit dylib candidates available", () => {
    const candidates = appleRemindersMacosBridgeCandidates({
      envDylibPath: "/tmp/custom-reminders.dylib",
    });

    expect(candidates).toEqual([
      {
        label: "ELIZA_NATIVE_PERMISSIONS_DYLIB",
        path: "/tmp/custom-reminders.dylib",
      },
      {
        label: "packaged Apple permissions bridge",
        path: `../../../../../../../${APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME}`,
      },
      {
        label: "packaged Apple permissions bridge",
        path: `../../../../../../${APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME}`,
      },
      {
        label: "local Apple permissions bridge",
        path: `../../../../packages/app-core/platforms/electrobun/src/${APPLE_REMINDERS_MACOS_BRIDGE_DYLIB_BASENAME}`,
      },
    ]);
  });

  it("omits the env candidate when no override is configured", () => {
    const labels = appleRemindersMacosBridgeCandidates().map(
      (candidate) => candidate.label,
    );

    expect(labels).not.toContain("ELIZA_NATIVE_PERMISSIONS_DYLIB");
  });
});

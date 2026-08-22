/** Locks the native EventKit boundary to portable provenance and invalidation. */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = dirname(fileURLToPath(import.meta.url));
const nativeSource = readFileSync(
  fileURLToPath(new URL("../native/macos/window-effects.mm", import.meta.url)),
  "utf8",
);
const nativeDylib = fileURLToPath(
  new URL("./libMacWindowEffects.dylib", import.meta.url),
);
const generationSmokeSource = fileURLToPath(
  new URL(
    "../native/macos/tests/eventkit-generation-smoke.mm",
    import.meta.url,
  ),
);

const calendarSerializer = nativeSource.slice(
  nativeSource.indexOf("static NSDictionary *elizaCalendarJson"),
  nativeSource.indexOf(
    "static NSDictionary *elizaAppleCalendarUnsupportedAttendeesError",
  ),
);

const generationBoundary = nativeSource.slice(
  nativeSource.indexOf(
    "static std::atomic<uint64_t> elizaAppleCalendarChangeGeneration",
  ),
  nativeSource.indexOf(
    "static NSDictionary *elizaAppleCalendarUnsupportedAttendeesError",
  ),
);

describe("macOS EventKit provenance contract", () => {
  it("serializes portable event identity, occurrence, modification, recurrence, and alarms", () => {
    for (const field of [
      '@"iCalUID"',
      '@"originalStartAt"',
      '@"lastModifiedAt"',
      '@"recurrenceRules"',
      '@"reminders"',
    ]) {
      expect(calendarSerializer).toContain(field);
    }
    expect(calendarSerializer).toContain("calendarItemExternalIdentifier");
    expect(calendarSerializer).toContain("occurrenceDate");
    expect(calendarSerializer).toContain("lastModifiedDate");
    expect(calendarSerializer).toContain("elizaRecurrenceRulesJson(event)");
    expect(calendarSerializer).toContain("elizaEventRemindersJson(event)");
  });

  it("keeps recurrence and reminder entries structurally explicit", () => {
    for (const field of [
      '@"frequency"',
      '@"interval"',
      '@"occurrenceCount"',
      '@"endDate"',
      '@"relativeOffsetSeconds"',
      '@"absoluteDate"',
      '@"locationTitle"',
    ]) {
      expect(nativeSource).toContain(field);
    }
    for (const frequency of ["daily", "weekly", "monthly", "yearly"]) {
      expect(nativeSource).toContain(`@"${frequency}"`);
    }
  });

  it("adds source provenance to both calendar and event JSON", () => {
    for (const field of [
      '@"sourceIdentifier"',
      '@"sourceTitle"',
      '@"sourceType"',
    ]) {
      expect(calendarSerializer.match(new RegExp(field, "g"))?.length).toBe(2);
    }
    for (const sourceType of [
      "local",
      "exchange",
      "caldav",
      "mobile_me",
      "subscribed",
      "birthdays",
      "unknown",
    ]) {
      expect(nativeSource).toContain(`@"${sourceType}"`);
    }
  });

  it("exposes only a monotonic store-change generation", () => {
    expect(generationBoundary).toContain("EKEventStoreChangedNotification");
    expect(generationBoundary).toContain(
      'extern "C" uint64_t appleCalendarEventStoreGeneration(void)',
    );
    expect(generationBoundary).toContain("compare_exchange_weak");
    expect(generationBoundary).toContain(
      "std::numeric_limits<uint64_t>::max()",
    );
    expect(generationBoundary).not.toContain("NSLog");
    expect(generationBoundary).not.toContain("userInfo");
    expect(generationBoundary).not.toContain("calendarItem");
  });

  it.skipIf(process.platform !== "darwin")(
    "increments the exported generation for real store-change notifications",
    () => {
      const build = spawnSync(
        "/bin/bash",
        [join(packageRoot, "../scripts/build-macos-effects.sh")],
        { encoding: "utf8" },
      );
      expect(build.status, build.stderr || build.stdout).toBe(0);
      expect(existsSync(nativeDylib)).toBe(true);

      const tempDir = mkdtempSync(join(tmpdir(), "eliza-eventkit-generation-"));
      try {
        const executable = join(tempDir, "eventkit-generation-smoke");
        const compile = spawnSync(
          "/usr/bin/xcrun",
          [
            "clang++",
            "-std=c++17",
            "-fobjc-arc",
            "-framework",
            "Foundation",
            "-framework",
            "EventKit",
            generationSmokeSource,
            "-o",
            executable,
          ],
          { encoding: "utf8" },
        );
        expect(compile.status, compile.stderr || compile.stdout).toBe(0);

        const smoke = spawnSync(executable, [nativeDylib], {
          encoding: "utf8",
        });
        expect(smoke.status, smoke.stderr || smoke.stdout).toBe(0);
        expect(smoke.stdout).toBe("");
        expect(smoke.stderr).toBe("");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  );
});

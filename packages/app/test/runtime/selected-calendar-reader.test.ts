import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";

test("actual shared Calendar reader scopes owner-day all-day events by civil dates", {
  skip: !process.env.ELIZA_JSON_JAR,
}, () => {
  const root = resolve(import.meta.dirname, "../../../.."),
    temporary = mkdtempSync(join(tmpdir(), "selected-calendar-")),
    fixtures = join(root, "plugins/plugin-native-calendar/test/jvm");
  const java =
    process.env.JAVA_HOME ||
    "/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home";
  function files(path: string): string[] {
    return readdirSync(path, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? files(join(path, entry.name))
        : entry.name.endsWith(".java")
          ? [join(path, entry.name)]
          : [],
    );
  }
  try {
    execFileSync(join(java, "bin/javac"), [
      "--release",
      "11",
      "-cp",
      process.env.ELIZA_JSON_JAR!,
      "-d",
      temporary,
      ...files(fixtures),
      join(
        root,
        "plugins/plugin-native-calendar/android/src/main/java/ai/eliza/plugins/calendar/CalendarEventGuard.java",
      ),
      join(
        root,
        "plugins/plugin-native-calendar/android/src/main/java/ai/eliza/plugins/calendar/read/SelectedCalendarReader.java",
      ),
    ]);
    expect(
      execFileSync(
        join(java, "bin/java"),
        [
          "-cp",
          temporary + ":" + process.env.ELIZA_JSON_JAR,
          "ai.eliza.plugins.calendar.read.SelectedCalendarReaderTest",
        ],
        { encoding: "utf8" },
      ),
    ).toMatch(/^PASS selected Calendar reader/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

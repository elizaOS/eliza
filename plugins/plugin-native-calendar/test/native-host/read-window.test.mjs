import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const tests = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(tests, "../..");
const source = process.env.ELIZA_CALENDAR_TEST_SOURCE || plugin;
const cache = join(
  homedir(),
  ".gradle/caches/modules-2/files-2.1/org.json/json/20250517",
);
const json =
  process.env.ALPHA_JSON_JAR ||
  (existsSync(cache) &&
    readdirSync(cache).flatMap((hash) =>
      readdirSync(join(cache, hash))
        .filter((name) => name === "json-20250517.jar")
        .map((name) => join(cache, hash, name)),
    )[0]);

test("shared Calendar range preserves complete reads and reports an explicit host bound", {
  skip: !json && "Pinned JVM JSON dependency unavailable",
}, () => {
  const temporary = mkdtempSync(join(tmpdir(), "shared-calendar-window-"));
  const binary = (name) =>
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  try {
    execFileSync(
      binary("javac"),
      [
        "--release",
        "11",
        "-cp",
        json,
        "-d",
        temporary,
        join(
          source,
          "android/src/main/java/ai/eliza/plugins/calendar/CalendarConfiguration.java",
        ),
        join(
          source,
          "android/src/main/java/ai/eliza/plugins/calendar/read/CalendarReadAccess.java",
        ),
        ...[
          "content/ContentResolver.java",
          "content/ContentUris.java",
          "database/Cursor.java",
        ].map((name) => join(plugin, "test/jvm/android", name)),
        ...[
          "content/Intent.java",
          "net/Uri.java",
          "provider/CalendarContract.java",
        ].map((name) => join(tests, "read-window/android", name)),
        join(tests, "read-window/CalendarReadWindowTest.java"),
      ],
      { timeout: 60000, stdio: "pipe" },
    );
    const output = execFileSync(
      binary("java"),
      [
        "-cp",
        `${temporary}:${json}`,
        "ai.eliza.plugins.calendar.read.CalendarReadWindowTest",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.match(output, /^PASS shared Calendar window:/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

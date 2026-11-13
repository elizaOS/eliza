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

function readThroughJvm(main, sources) {
  const temporary = mkdtempSync(join(tmpdir(), "shared-calendar-window-"));
  const binary = (name) =>
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  try {
    execFileSync(
      binary("javac"),
      ["--release", "11", "-cp", json, "-d", temporary, ...sources],
      { timeout: 60000, stdio: "pipe" },
    );
    return execFileSync(
      binary("java"),
      ["-cp", `${temporary}:${json}`, `ai.eliza.plugins.calendar.read.${main}`],
      { encoding: "utf8", timeout: 30000 },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const javaSource = join(
  source,
  "android/src/main/java/ai/eliza/plugins/calendar",
);
const stubs = join(plugin, "test/jvm/android");
const dependencies = [
  "content/ContentResolver.java",
  "content/ContentUris.java",
  "database/Cursor.java",
];
const options = { skip: !json && "Pinned JVM JSON dependency unavailable" };

test(
  "shared Calendar range preserves complete reads and reports an explicit host bound",
  options,
  () => {
    const output = readThroughJvm("CalendarReadWindowTest", [
      join(javaSource, "CalendarConfiguration.java"),
      join(javaSource, "read/CalendarReadAccess.java"),
      ...dependencies.map((name) => join(stubs, name)),
      ...[
        "content/Intent.java",
        "net/Uri.java",
        "provider/CalendarContract.java",
      ].map((name) => join(tests, "read-window/android", name)),
      join(tests, "read-window/CalendarReadWindowTest.java"),
    ]);
    assert.match(output, /^PASS shared Calendar window:/);
  },
);

test(
  "selected workflow Calendar reads preserve timed bounds and the reviewed civil days",
  options,
  () => {
    const output = readThroughJvm("SelectedCalendarReaderTest", [
      join(javaSource, "read/CalendarSourceIdentity.java"),
      join(javaSource, "read/SelectedCalendarReader.java"),
      ...dependencies.map((name) => join(stubs, name)),
      ...[
        "content/ContentValues.java",
        "net/Uri.java",
        "provider/CalendarContract.java",
      ].map((name) => join(stubs, name)),
      join(plugin, "test/jvm/SelectedCalendarReaderTest.java"),
    ]);
    assert.match(output, /^PASS selected Calendar reader:/);
  },
);

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

test("calendar creation journal settles definite failures and dismissed unknowns without replay", {
  skip: !json && "Pinned JVM JSON dependency unavailable",
}, () => {
  const temporary = mkdtempSync(join(tmpdir(), "calendar-creation-store-"));
  const binary = (name) =>
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", name) : name;
  const runtime = join(tests, "bridge-runtime/android");
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
        ...["CalendarConfiguration.java", "CalendarCreationStore.java"].map(
          (name) =>
            join(
              source,
              "android/src/main/java/ai/eliza/plugins/calendar",
              name,
            ),
        ),
        ...[
          "content/ContentResolver.java",
          "content/ContentUris.java",
          "content/ContentValues.java",
          "content/Context.java",
          "content/Intent.java",
          "content/SharedPreferences.java",
          "content/pm/ActivityInfo.java",
          "content/pm/PackageManager.java",
          "content/pm/ResolveInfo.java",
          "database/Cursor.java",
          "net/Uri.java",
        ].map((name) => join(runtime, name)),
        ...[
          "android/provider/CalendarContract.java",
          "com/getcapacitor/JSArray.java",
          "com/getcapacitor/JSObject.java",
          "CalendarCreationStoreTest.java",
        ].map((name) => join(tests, "creation-store", name)),
      ],
      { timeout: 60000, stdio: "pipe" },
    );
    const output = execFileSync(
      binary("java"),
      [
        "-cp",
        `${temporary}:${json}`,
        "ai.eliza.plugins.calendar.CalendarCreationStoreTest",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.match(output, /^PASS calendar creation journal:/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

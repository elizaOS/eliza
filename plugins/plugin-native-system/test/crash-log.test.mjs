// Shared privacy-bounded problem log (crash.CrashLog) on a plain JVM with Android stand-ins. This
// builds no APK and runs nothing on Android; the instrumented host test covers a real device.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

const stubs = {
  "android/content/Context.java":
    'package android.content; public class Context {public static final String ACTIVITY_SERVICE="activity";public boolean noBackupBroken;private final java.io.File dir;public Context(){try{dir=java.nio.file.Files.createTempDirectory("crash-log-ctx").toFile();}catch(java.io.IOException e){throw new RuntimeException(e);}}public Context getApplicationContext(){return this;}public java.io.File getNoBackupFilesDir(){if(noBackupBroken)throw new IllegalStateException("fixture");return dir;}public Object getSystemService(String name){return ACTIVITY_SERVICE.equals(name)?new android.app.ActivityManager():null;}public String getPackageName(){return "fixture.example";}}',
  "android/app/ActivityManager.java":
    'package android.app; public class ActivityManager {public static java.util.List<ApplicationExitInfo> exits=new java.util.ArrayList<>();public java.util.List<ApplicationExitInfo> getHistoricalProcessExitReasons(String pkg,int pid,int max){if(pkg!=null)throw new AssertionError("own package");java.util.List<ApplicationExitInfo> out=new java.util.ArrayList<>(exits);java.util.Collections.reverse(out);return out.subList(0,Math.min(max,out.size()));}}',
  "android/app/ApplicationExitInfo.java":
    "package android.app; public final class ApplicationExitInfo {public static final int REASON_UNKNOWN=0,REASON_EXIT_SELF=1,REASON_SIGNALED=2,REASON_LOW_MEMORY=3,REASON_CRASH=4,REASON_CRASH_NATIVE=5,REASON_ANR=6,REASON_INITIALIZATION_FAILURE=7,REASON_PERMISSION_CHANGE=8,REASON_EXCESSIVE_RESOURCE_USAGE=9,REASON_USER_REQUESTED=10,REASON_USER_STOPPED=11,REASON_DEPENDENCY_DIED=12,REASON_OTHER=13,REASON_FREEZER=14;private final long at;private final int reason,status;private final String process;public ApplicationExitInfo(long at,int reason,int status,String process){this.at=at;this.reason=reason;this.status=status;this.process=process;}public long getTimestamp(){return at;}public int getReason(){return reason;}public int getStatus(){return status;}public String getProcessName(){return process;}}",
  "android/os/Build.java":
    "package android.os; public class Build {public static class VERSION {public static int SDK_INT=36;} public static class VERSION_CODES {public static final int R=30;}}",
  "android/os/Looper.java":
    "package android.os; public final class Looper {private static final Looper MAIN=new Looper();private final Thread thread=Thread.currentThread();public static Looper getMainLooper(){return MAIN;}public Thread getThread(){return thread;}}",
  "android/util/AtomicFile.java":
    "package android.util; public class AtomicFile {private final java.io.File file;public AtomicFile(java.io.File f){file=f;}public java.io.FileInputStream openRead()throws java.io.FileNotFoundException{return new java.io.FileInputStream(file);}public java.io.FileOutputStream startWrite()throws java.io.IOException{return new java.io.FileOutputStream(file);}public void finishWrite(java.io.FileOutputStream out)throws java.io.IOException{out.close();}public void failWrite(java.io.FileOutputStream out){try{out.close();}catch(Exception ignored){}}}",
};

test("crash log keeps failure classes only, bounded, with a redacted export (plain JVM)", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-crash-log-"));
  try {
    const sources = [];
    for (const [name, body] of Object.entries(stubs)) {
      const file = path.join(temp, "src", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      sources.push(file);
    }
    const json = path.join(root, "test/crash-log-stubs/org/json");
    for (const name of fs.readdirSync(json))
      sources.push(path.join(json, name));
    execFileSync(
      java("javac"),
      [
        "--release",
        "17",
        "-d",
        path.join(temp, "classes"),
        ...sources,
        path.join(
          root,
          "android/src/main/java/ai/eliza/plugins/system/crash/CrashLog.java",
        ),
        path.join(root, "test/CrashLogTest.java"),
      ],
      { timeout: 120000 },
    );
    assert.match(
      execFileSync(
        java("java"),
        [
          "-cp",
          path.join(temp, "classes"),
          "ai.eliza.plugins.system.crash.CrashLogTest",
        ],
        { encoding: "utf8", timeout: 60000 },
      ),
      /^PASS crash log \(\d+ checks\)/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("renderer contract re-applies the allowlist to native and stored entries", async () => {
  const {
    CRASH_LOG_MAX_ENTRIES,
    CRASH_LOG_RETENTION_MS,
    describeNativeCrashEntry,
    errorClassOf,
    exportCrashLog,
    readNativeCrashLog,
    sanitizeCrashEntries,
  } = await import("../src/crash-log.ts");
  const now = 1_800_000_000_000;
  const secret = "note: 221B Baker Street";
  const entries = sanitizeCrashEntries(
    [
      {
        at: now - 10,
        source: "uncaught",
        errorClass: "java.lang.IllegalStateException",
        rootClass: "java.io.IOException",
        thread: "main",
        process: "main",
        message: secret,
      },
      { at: now - 9, source: "exit", reason: "anr", process: ":isolated_pdf" },
      { at: now - 8, source: "exit", reason: secret },
      { at: now - 7, source: "renderer", kind: "render", errorClass: secret },
      { at: now - 6, source: "renderer", kind: "made-up" },
      { at: now - 5, source: "trace", text: secret },
      { at: now - CRASH_LOG_RETENTION_MS - 1, source: "exit", reason: "crash" },
      { at: "now", source: "exit", reason: "crash" },
      null,
      [],
      { at: now - 4, source: "uncaught", thread: secret, process: secret },
    ],
    now,
  );
  assert.equal(entries.length, 4);
  assert.ok(!JSON.stringify(entries).includes("Baker"));
  assert.deepEqual(entries[0], {
    at: now - 10,
    source: "uncaught",
    errorClass: "java.lang.IllegalStateException",
    rootClass: "java.io.IOException",
    process: "main",
    thread: "main",
  });
  assert.deepEqual(entries[2], {
    at: now - 7,
    source: "renderer",
    kind: "render",
  });
  const many = Array.from({ length: CRASH_LOG_MAX_ENTRIES + 5 }, (_, i) => ({
    at: now - 100 + i,
    source: "exit",
    reason: "crash",
  }));
  const bounded = sanitizeCrashEntries(many.reverse(), now);
  assert.equal(bounded.length, CRASH_LOG_MAX_ENTRIES);
  assert.equal(bounded.at(-1).at, now - 100 + CRASH_LOG_MAX_ENTRIES + 4);
  assert.deepEqual(sanitizeCrashEntries("nope", now), []);

  assert.equal(errorClassOf(new TypeError("x")), "TypeError");
  const odd = new Error(secret);
  odd.name = secret;
  assert.equal(errorClassOf(odd), "Error");
  assert.equal(errorClassOf(null), "null");
  assert.equal(errorClassOf("text"), "string");

  assert.deepEqual(describeNativeCrashEntry(entries[1]), {
    title: "App process stopped: anr",
    detail: "Reported by Android · :isolated_pdf process",
  });
  assert.equal(
    describeNativeCrashEntry(entries[0]).detail,
    "java.lang.IllegalStateException · caused by java.io.IOException · main thread",
  );

  const exported = exportCrashLog(
    [{ at: now - 1, source: "uncaught", message: secret }],
    now,
  );
  assert.deepEqual(exported, {
    version: 1,
    exportedAt: now,
    entries: [{ at: now - 1, source: "uncaught" }],
  });

  assert.deepEqual(await readNativeCrashLog(null, now), {
    entries: [],
    exitHistory: false,
  });
  const read = await readNativeCrashLog(
    {
      crashLog: async () => ({
        entries: [
          { at: now - 1, source: "exit", reason: "crash", extra: secret },
        ],
        exitHistory: true,
      }),
      recordRendererFailure: async () => {},
      clearCrashLog: async () => {},
    },
    now,
  );
  assert.deepEqual(read, {
    entries: [{ at: now - 1, source: "exit", reason: "crash" }],
    exitHistory: true,
  });
});

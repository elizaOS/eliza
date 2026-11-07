import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DATA_RESET_UNCONFIRMED, reviewDataReset } from "../src/reset.ts";

const root = path.resolve(import.meta.dirname, "..");
const resetSource = (name) =>
  path.join(
    root,
    "android/src/main/java/ai/eliza/plugins/system/reset",
    `${name}.java`,
  );
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

/** Minimal Android stand-ins: only what the coordinator calls, with observable counters. */
const stubs = {
  "android/app/Activity.java":
    "package android.app; public class Activity extends android.content.Context {}",
  "android/app/ActivityManager.java":
    'package android.app; public class ActivityManager {public static int calls,mode;public static Runnable onClear=()->{};public static java.util.List<ApplicationStartInfo> starts=new java.util.ArrayList<>();public static boolean startsFail;public boolean clearApplicationUserData(){calls++;onClear.run();if(mode==2)throw new SecurityException("fixture refusal");return mode==0;}public java.util.List<ApplicationStartInfo> getHistoricalProcessStartReasons(int max){if(startsFail)throw new IllegalStateException("fixture");return starts;}}',
  "android/app/ApplicationStartInfo.java":
    "package android.app; public final class ApplicationStartInfo {public static final int START_REASON_ALARM=0,START_REASON_BACKUP=1,START_REASON_BOOT_COMPLETE=2,START_REASON_BROADCAST=3,START_REASON_CONTENT_PROVIDER=4,START_REASON_JOB=5,START_REASON_LAUNCHER=6,START_REASON_LAUNCHER_RECENTS=7,START_REASON_OTHER=8,START_REASON_PUSH=9,START_REASON_SERVICE=10,START_REASON_START_ACTIVITY=11;private final int pid,reason;public ApplicationStartInfo(int pid,int reason){this.pid=pid;this.reason=reason;}public int getPid(){return pid;}public int getReason(){return reason;}}",
  "android/content/Context.java":
    'package android.content; public class Context {public static java.io.File data;public static int recoveries;public static android.app.ActivityManager manager=new android.app.ActivityManager();public Context createDeviceProtectedStorageContext(){return this;}public java.io.File getNoBackupFilesDir(){data.mkdirs();return data;}public <T>T getSystemService(Class<T> type){return type.cast(manager);}public String getPackageName(){return "fixture.example";}public void startActivity(Intent intent){if(!"ai.eliza.plugins.system.reset.DataResetTest$Recovery".equals(intent.target.getName())||intent.flags!=(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK))throw new AssertionError("unexpected start");recoveries++;}}',
  "android/content/Intent.java":
    "package android.content; public class Intent {public static final int FLAG_ACTIVITY_NEW_TASK=0x10000000,FLAG_ACTIVITY_CLEAR_TASK=0x8000;public final Class<?> target;public int flags;public Intent(Context c,Class<?> t){target=t;}public Intent addFlags(int f){flags|=f;return this;}}",
  "android/os/Build.java":
    "package android.os; public class Build {public static class VERSION {public static int SDK_INT=36;}}",
  "android/os/Process.java":
    "package android.os; public final class Process {public static class Exit extends Error{}public static boolean isolated;public static int myPid(){return 123;}public static boolean isIsolated(){return isolated;}public static void killProcess(int pid){throw new Exit();}}",
  "android/util/AtomicFile.java":
    "package android.util; public class AtomicFile {private final java.io.File file;public AtomicFile(java.io.File f){file=f;}public java.io.File getBaseFile(){return file;}public java.io.FileOutputStream startWrite()throws java.io.IOException{return new java.io.FileOutputStream(file);}public void finishWrite(java.io.FileOutputStream out)throws java.io.IOException{out.getFD().sync();out.close();}public void failWrite(java.io.FileOutputStream out){try{out.close();}catch(Exception ignored){}}public byte[] readFully()throws java.io.IOException{return java.nio.file.Files.readAllBytes(file.toPath());}public void delete(){file.delete();}}",
  "android/util/Log.java":
    "package android.util; public class Log {public static int w(String tag,String message){return 0;}}",
  "android/system/OsConstants.java":
    "package android.system; public class OsConstants {public static final int O_RDONLY=0;}",
  "android/system/Os.java":
    "package android.system; public class Os {public static java.io.FileDescriptor open(String path,int flags,int mode){return new java.io.FileDescriptor();}public static void fsync(java.io.FileDescriptor fd){}public static void close(java.io.FileDescriptor fd){}}",
  "ai/eliza/plugins/system/SenseListenerClient.java":
    "package ai.eliza.plugins.system; public final class SenseListenerClient {public static boolean acknowledged=true;public static int calls;public static Runnable onReset=()->{};public SenseListenerClient(android.content.Context context){}public boolean resetForData(){calls++;onReset.run();return acknowledged;}}",
};

test("reset coordinator: fresh authorization, bounded fail-closed admission and single dispatch", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-data-reset-"));
  try {
    const sources = [];
    for (const [name, body] of Object.entries(stubs)) {
      const file = path.join(temp, "src", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      sources.push(file);
    }
    const sibling = path.join(temp, "other-app");
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "keep"), "x");
    execFileSync(
      java("javac"),
      [
        "--release",
        "17",
        "-d",
        path.join(temp, "classes"),
        ...sources,
        resetSource("DataReset"),
        resetSource("DataResetCopy"),
        resetSource("ResetAuthorization"),
        path.join(root, "test/DataResetTest.java"),
      ],
      { timeout: 120000 },
    );
    assert.match(
      execFileSync(
        java("java"),
        [
          "-cp",
          path.join(temp, "classes"),
          "ai.eliza.plugins.system.reset.DataResetTest",
          path.join(temp, "private"),
          sibling,
        ],
        { encoding: "utf8", timeout: 60000 },
      ),
      /^PASS data reset/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("reset deletion stays package-scoped and the surfaces never claim completion", () => {
  const coordinator = fs.readFileSync(resetSource("DataReset"), "utf8");
  assert.match(coordinator, /clearApplicationUserData\(\)/);
  assert.doesNotMatch(coordinator, /clearApplicationUserData\([^)]/);
  assert.doesNotMatch(
    coordinator,
    /listFiles|deleteRecursively|Runtime\.getRuntime|"pm |getExternal|MediaStore|deleteDatabase/,
  );
  const plugin = fs.readFileSync(resetSource("DataResetPlugin"), "utf8");
  // Renderer input carries no authority: review() reads no call options.
  assert.doesNotMatch(plugin, /call\.(get|has)[A-Z]/);
  assert.match(plugin, /createConfirmDeviceCredentialIntent/);
  const authenticated = plugin.slice(
    plugin.indexOf("private void authenticated"),
  );
  assert.ok(
    authenticated.indexOf("reset.record(") > 0 &&
      authenticated.indexOf("dispatchAfterBeforeDispatch(") >
        authenticated.indexOf("reset.record("),
    "the request is durable before any pre-dispatch work",
  );
  const statuses = new Set(
    [...plugin.matchAll(/result\(call, "([a-z]+)"/g)].map((match) => match[1]),
  );
  assert.deepEqual([...statuses].sort(), ["cancelled", "unavailable"]);
  const recovery = fs.readFileSync(
    resetSource("DataResetRecoveryActivity"),
    "utf8",
  );
  assert.match(
    recovery,
    /settingsIntent\(\)/,
    "listener destination is the validated same-signer activity",
  );
  assert.doesNotMatch(recovery, /new ComponentName/);
});

test("renderer helper reports only native non-completion outcomes", async () => {
  assert.deepEqual(
    await reviewDataReset({
      review: async () => ({ status: "cancelled", message: "Nothing reset." }),
    }),
    { status: "cancelled", message: "Nothing reset." },
  );
  assert.deepEqual(
    await reviewDataReset({
      review: async () => ({ status: "unavailable", message: "Set a lock." }),
    }),
    { status: "unavailable", message: "Set a lock." },
  );
  for (const answer of [
    { status: "completed", message: "Erased." },
    { status: "cancelled" },
    { status: "cancelled", message: "" },
    { status: "cancelled", message: "x".repeat(501) },
    null,
    "cancelled",
  ]) {
    assert.deepEqual(await reviewDataReset({ review: async () => answer }), {
      status: "unavailable",
      message: DATA_RESET_UNCONFIRMED,
    });
  }
  assert.deepEqual(
    await reviewDataReset({
      review: async () => {
        throw new Error("bridge");
      },
    }),
    { status: "unavailable", message: DATA_RESET_UNCONFIRMED },
  );
  assert.deepEqual(await reviewDataReset(null), {
    status: "unavailable",
    message: DATA_RESET_UNCONFIRMED,
  });
});

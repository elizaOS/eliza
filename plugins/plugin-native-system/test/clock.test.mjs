// Shared Clock handoff (clock.ClockDays, ClockProfile, ClockHandoff) on a plain JVM with Android
// stand-ins. Builds no APK and starts no Clock app; real handlers need an instrumented run.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const clock = (name) =>
  path.join(
    root,
    "android/src/main/java/ai/eliza/plugins/system/clock",
    `${name}.java`,
  );

const stubs = {
  "android/content/Context.java":
    'package android.content; public class Context {public static final String KEYGUARD_SERVICE="keyguard";public Object getSystemService(String name){return KEYGUARD_SERVICE.equals(name)?new android.app.KeyguardManager():null;}public String getPackageName(){return "host.app";}}',
  "android/content/ComponentName.java":
    "package android.content; public final class ComponentName {public final String packageName,className;public ComponentName(String p,String c){packageName=p;className=c;}}",
  "android/content/ActivityNotFoundException.java":
    "package android.content; public class ActivityNotFoundException extends RuntimeException {}",
  "android/content/Intent.java":
    "package android.content; public class Intent {public final String action;public final java.util.Map<String,Object> extras=new java.util.HashMap<>();public ComponentName component;public Intent(String a){action=a;}public Intent putExtra(String k,int v){extras.put(k,v);return this;}public Intent putExtra(String k,boolean v){extras.put(k,v);return this;}public Intent putExtra(String k,String v){extras.put(k,v);return this;}public Intent putIntegerArrayListExtra(String k,java.util.ArrayList<Integer> v){extras.put(k,v);return this;}public Intent setComponent(ComponentName c){component=c;return this;}}",
  "android/content/pm/ActivityInfo.java":
    "package android.content.pm; public class ActivityInfo {public String packageName,name;}",
  "android/content/pm/ResolveInfo.java":
    "package android.content.pm; public class ResolveInfo {public ActivityInfo activityInfo;}",
  "android/content/pm/PackageManager.java":
    'package android.content.pm; public class PackageManager {private final android.app.Activity owner;public PackageManager(android.app.Activity owner){this.owner=owner;}public ResolveInfo resolveActivity(android.content.Intent intent,int flags){if(owner.resolvedPackage==null)return null;ResolveInfo info=new ResolveInfo();info.activityInfo=new ActivityInfo();info.activityInfo.packageName=owner.resolvedPackage;info.activityInfo.name=owner.resolvedPackage+".AlarmActivity";return info;}}',
  "android/app/KeyguardManager.java":
    "package android.app; public class KeyguardManager {public static boolean locked;public boolean isKeyguardLocked(){return locked;}}",
  "android/app/Activity.java":
    'package android.app; public class Activity extends android.content.Context {public boolean focus=true;public String resolvedPackage="clock.app";public RuntimeException failure;public final java.util.List<android.content.Intent> started=new java.util.ArrayList<>();public boolean isFinishing(){return false;}public boolean isDestroyed(){return false;}public boolean hasWindowFocus(){return focus;}public android.content.pm.PackageManager getPackageManager(){return new android.content.pm.PackageManager(this);}public void startActivity(android.content.Intent intent){if(failure!=null)throw failure;started.add(intent);}}',
  "android/provider/AlarmClock.java":
    'package android.provider; public final class AlarmClock {public static final String ACTION_SET_ALARM="set",ACTION_SHOW_ALARMS="show",ACTION_DISMISS_ALARM="dismiss",ACTION_SNOOZE_ALARM="snooze",EXTRA_HOUR="hour",EXTRA_MINUTES="minutes",EXTRA_MESSAGE="message",EXTRA_SKIP_UI="skip",EXTRA_DAYS="days",EXTRA_ALARM_SNOOZE_DURATION="snoozeDuration";}',
  "android/icu/util/TimeZone.java":
    'package android.icu.util; public final class TimeZone {public static String getCanonicalID(String id){return java.util.Set.of(java.util.TimeZone.getAvailableIDs()).contains(id)?("Etc/UTC".equals(id)?"UTC":id):null;}}',
};

test("shared Clock handoff: exact repeat days, profiles, intents and launch outcomes (plain JVM)", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-clock-"));
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
        clock("ClockDays"),
        clock("ClockProfile"),
        clock("ClockHandoff"),
        path.join(root, "test/ClockHandoffTest.java"),
      ],
      { timeout: 120000 },
    );
    assert.match(
      execFileSync(
        java("java"),
        [
          "-Duser.timezone=UTC",
          "-cp",
          path.join(temp, "classes"),
          "ai.eliza.plugins.system.clock.ClockHandoffTest",
        ],
        { encoding: "utf8", timeout: 60000 },
      ),
      /^PASS clock handoff \(\d+ checks\)/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

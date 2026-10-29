import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Compiles every Android source against the SDK platform jar. This is a compile check, not a
// device test: it proves the module builds against the framework API it targets.
const plugin = fileURLToPath(new URL("../..", import.meta.url));
const sources = path.join(
  plugin,
  "android/src/main/java/ai/eliza/plugins/notifications",
);
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const platform = (() => {
  if (!sdk) return null;
  const root = path.join(sdk, "platforms");
  if (!fs.existsSync(root)) return null;
  const versions = fs
    .readdirSync(root)
    .map((name) => /^android-(\d+)$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]))
    .filter(
      (level) =>
        level >= 33 &&
        fs.existsSync(path.join(root, `android-${level}`, "android.jar")),
    )
    .sort((a, b) => b - a);
  return versions.length
    ? path.join(root, `android-${versions[0]}`, "android.jar")
    : null;
})();
/** @param {string} name */
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
test("android sources compile against the SDK platform", (t) => {
  assert.ok(
    platform,
    "ANDROID_HOME/ANDROID_SDK_ROOT with an android-33+ platform is required",
  );
  const classes = fs.mkdtempSync(
    path.join(os.tmpdir(), "notification-mirror-android-"),
  );
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  const files = fs
    .readdirSync(sources)
    .filter((name) => name.endsWith(".java"))
    .map((name) => path.join(sources, name));
  execFileSync(
    bin("javac"),
    [
      "--release",
      "17",
      "-Xlint:-options",
      "-classpath",
      platform,
      "-d",
      classes,
      ...files,
    ],
    { timeout: 180000 },
  );
  for (const name of [
    "NoticeIds",
    "NoticeWorker",
    "NotificationMirror",
    "NotificationMirrorConfig",
    "NotificationMirrorPolicy",
    "NotificationMirrorListenerService",
  ]) {
    assert.ok(
      fs.existsSync(
        path.join(classes, "ai/eliza/plugins/notifications", `${name}.class`),
      ),
      name,
    );
  }
});

// Minimal Capacitor bridge surface used by NotificationsHostPlugin, with the real signatures
// (com.getcapacitor 7/8). The host plugin compiles against these plus the SDK platform jar; this
// proves its Android API use, not Capacitor's runtime dispatch.
const capacitorStubs = {
  "com/getcapacitor/JSObject.java":
    "package com.getcapacitor; public class JSObject extends org.json.JSONObject {public JSObject(){}public JSObject(String json)throws org.json.JSONException{super(json);}public static JSObject fromJSONObject(org.json.JSONObject o)throws org.json.JSONException{return new JSObject(o.toString());}@Override public JSObject put(String k,boolean v){return this;}@Override public JSObject put(String k,int v){return this;}@Override public JSObject put(String k,long v){return this;}@Override public JSObject put(String k,double v){return this;}@Override public JSObject put(String k,Object v){return this;}public JSObject put(String k,String v){return this;}}",
  "com/getcapacitor/JSArray.java":
    "package com.getcapacitor; public class JSArray extends org.json.JSONArray {public JSArray(){}public JSArray(String json)throws org.json.JSONException{super(json);}}",
  "com/getcapacitor/PluginMethod.java":
    "package com.getcapacitor; @java.lang.annotation.Retention(java.lang.annotation.RetentionPolicy.RUNTIME) public @interface PluginMethod {}",
  "com/getcapacitor/PluginCall.java":
    "package com.getcapacitor; public class PluginCall {public void resolve(JSObject d){}public void resolve(){}public void reject(String m){}public JSObject getData(){return null;}public String getString(String n){return null;}public String getString(String n,String d){return d;}public Boolean getBoolean(String n){return null;}public Boolean getBoolean(String n,Boolean d){return d;}public JSObject getObject(String n){return null;}public JSArray getArray(String n){return null;}}",
  "com/getcapacitor/Plugin.java":
    "package com.getcapacitor; public class Plugin {public void load(){}public android.content.Context getContext(){return null;}public android.app.Activity getActivity(){return null;}protected void notifyListeners(String e,JSObject d,boolean r){}protected void handleOnNewIntent(android.content.Intent i){}protected void handleOnResume(){}protected void handleOnPause(){}protected void handleOnDestroy(){}}",
};
test("Capacitor host plugin compiles against the SDK platform", (t) => {
  assert.ok(
    platform,
    "ANDROID_HOME/ANDROID_SDK_ROOT with an android-33+ platform is required",
  );
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "notifications-host-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const stubFiles = Object.entries(capacitorStubs).map(([name, body]) => {
    const file = path.join(temp, "stubs", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    return file;
  });
  const capacitor = path.join(
    plugin,
    "android/src/capacitor/java/ai/eliza/plugins/notifications",
  );
  const files = [sources, capacitor].flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".java"))
      .map((name) => path.join(dir, name)),
  );
  execFileSync(
    bin("javac"),
    [
      "--release",
      "17",
      "-Xlint:-options",
      "-classpath",
      platform,
      "-d",
      path.join(temp, "classes"),
      ...stubFiles,
      ...files,
    ],
    { timeout: 180000 },
  );
  assert.ok(
    fs.existsSync(
      path.join(
        temp,
        "classes/ai/eliza/plugins/notifications/NotificationsHostPlugin.class",
      ),
    ),
  );
});

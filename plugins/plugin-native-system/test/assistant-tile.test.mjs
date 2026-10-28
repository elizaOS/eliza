import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The shared assistant entry tile (AssistantEntryTile) and the Eliza app's voice tile that uses it,
// run on a plain JVM against Android stand-ins. No Android device, SystemUI or permission is used.
const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "../..");
const sharedTile = path.join(
  root,
  "android/src/main/java/ai/eliza/plugins/system/AssistantEntryTile.java",
);
const elizaTile = path.join(
  repo,
  "packages/app/platforms/android/app/src/main/java/ai/elizaos/app/ElizaVoiceTileService.java",
);
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

const stubs = {
  "android/annotation/SuppressLint.java":
    "package android.annotation; public @interface SuppressLint {String[] value();}",
  "android/annotation/TargetApi.java":
    "package android.annotation; public @interface TargetApi {int value();}",
  "android/content/Context.java":
    "package android.content; public class Context {public String getString(int id){return String.valueOf(id);}}",
  "android/net/Uri.java":
    "package android.net; public class Uri {private final String value;private Uri(String v){value=v;}public static Uri parse(String s){return new Uri(s);}public String toString(){return value;}}",
  "android/content/Intent.java":
    'package android.content; public class Intent {public static final String ACTION_ASSIST="android.intent.action.ASSIST",ACTION_VIEW="android.intent.action.VIEW";public static final int FLAG_ACTIVITY_NEW_TASK=0x10000000,FLAG_ACTIVITY_CLEAR_TOP=0x04000000,FLAG_ACTIVITY_SINGLE_TOP=0x20000000;public Class<?> target;public String action;public android.net.Uri data;public int flags;public Intent(Context context,Class<?> cls){target=cls;}public Intent setAction(String a){action=a;return this;}public Intent setData(android.net.Uri u){data=u;return this;}public Intent setFlags(int f){flags=f;return this;}public Intent addFlags(int f){flags|=f;return this;}}',
  "android/app/PendingIntent.java":
    "package android.app; public class PendingIntent {public static final int FLAG_UPDATE_CURRENT=0x08000000,FLAG_IMMUTABLE=0x04000000;public android.content.Intent intent;public int flags,requestCode;public static PendingIntent getActivity(android.content.Context c,int request,android.content.Intent i,int f){PendingIntent p=new PendingIntent();p.intent=i;p.flags=f;p.requestCode=request;return p;}}",
  "android/graphics/drawable/Icon.java":
    "package android.graphics.drawable; public class Icon {}",
  "android/os/Build.java":
    "package android.os; public class Build {public static class VERSION {public static int SDK_INT=36;}public static class VERSION_CODES {public static final int N=24,Q=29,UPSIDE_DOWN_CAKE=34;}}",
  "android/service/quicksettings/Tile.java":
    "package android.service.quicksettings; public class Tile {public static final int STATE_UNAVAILABLE=0,STATE_INACTIVE=1,STATE_ACTIVE=2;public int state=STATE_ACTIVE,updates;public boolean subtitleSet;public CharSequence label,subtitle,description;public android.graphics.drawable.Icon icon;public void setIcon(android.graphics.drawable.Icon i){icon=i;}public void setLabel(CharSequence s){label=s;}public void setSubtitle(CharSequence s){subtitle=s;subtitleSet=true;}public void setContentDescription(CharSequence s){description=s;}public void setState(int s){state=s;}public void updateTile(){updates++;}}",
  "android/service/quicksettings/TileService.java":
    "package android.service.quicksettings; public class TileService extends android.content.Context {public boolean locked;public Runnable unlock;public Tile tile=new Tile();public int launched;public android.content.Intent lastIntent;public android.app.PendingIntent lastPending;public void onStartListening(){}public void onClick(){}public Tile getQsTile(){return tile;}public boolean isLocked(){return locked;}public void unlockAndRun(Runnable r){unlock=r;}public void startActivityAndCollapse(android.content.Intent i){lastIntent=i;launched++;}public void startActivityAndCollapse(android.app.PendingIntent p){lastPending=p;lastIntent=p.intent;launched++;}}",
  "ai/elizaos/app/MainActivity.java":
    "package ai.elizaos.app; public class MainActivity {}",
};

test("the assistant entry tile waits for unlock, opens one immutable entry and never reports an active state", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-assistant-tile-"));
  try {
    const files = [];
    for (const [name, body] of Object.entries(stubs)) {
      const file = path.join(temp, "src", name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      files.push(file);
    }
    execFileSync(
      java("javac"),
      [
        "--release",
        "17",
        "-d",
        path.join(temp, "classes"),
        ...files,
        sharedTile,
        elizaTile,
        path.join(root, "test/AssistantEntryTileTest.java"),
      ],
      { timeout: 120000 },
    );
    assert.match(
      execFileSync(
        java("java"),
        [
          "-cp",
          path.join(temp, "classes"),
          "ai.eliza.plugins.system.AssistantEntryTileTest",
        ],
        { encoding: "utf8", timeout: 60000 },
      ),
      /^PASS assistant entry tile/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("the tile carries no capture, permission or lock-screen shortcut, and only hosts declare it", () => {
  const source = fs.readFileSync(sharedTile, "utf8");
  for (const forbidden of [
    "requestPermissions",
    "startForegroundService",
    "setShowWhenLocked",
    "setTurnScreenOn",
    "requestDismissKeyguard",
    "putExtra(",
    "setData(",
    "STATE_ACTIVE",
  ])
    assert.ok(!source.includes(forbidden), forbidden);
  // The library declares no tile, so a host without an assistant entry never shows one.
  const library = fs.readFileSync(
    path.join(root, "android/src/main/AndroidManifest.xml"),
    "utf8",
  );
  assert.doesNotMatch(library, /QS_TILE|BIND_QUICK_SETTINGS_TILE/);
  // The Eliza app keeps its installed component and declares it as SystemUI-bound action tile.
  assert.match(
    fs.readFileSync(elizaTile, "utf8"),
    /class ElizaVoiceTileService extends AssistantEntryTile/,
  );
  const manifest = fs.readFileSync(
    path.join(
      repo,
      "packages/app/platforms/android/app/src/main/AndroidManifest.xml",
    ),
    "utf8",
  );
  const entry = manifest.match(
    /<service\s+android:name="ai\.elizaos\.app\.ElizaVoiceTileService"[\s\S]*?<\/service>/,
  )?.[0];
  assert.ok(entry, "the Eliza voice tile is declared");
  assert.match(
    entry,
    /android:permission="android\.permission\.BIND_QUICK_SETTINGS_TILE"/,
  );
  assert.match(
    entry,
    /android:name="android\.service\.quicksettings\.TOGGLEABLE_TILE"\s+android:value="false"/,
  );
});

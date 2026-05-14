import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ANDROID_APP_ACTION_CAPABILITIES,
  ANDROID_APP_ACTION_SHORTCUT_IDS,
  ensureAndroidMainActivityShortcutsMetadata,
  patchAndroidAppActionsXmlResource,
  validateAndroidAppActionsXmlResource,
} from "./run-mobile-build.mjs";

test("Android MainActivity receives App Actions shortcuts metadata once", () => {
  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>`;

  const patched = ensureAndroidMainActivityShortcutsMetadata(manifest);
  const repatched = ensureAndroidMainActivityShortcutsMetadata(patched);

  assert.match(patched, /android:name="android\.app\.shortcuts"/);
  assert.match(patched, /android:resource="@xml\/shortcuts"/);
  assert.equal(
    patched.match(/android:name="android\.app\.shortcuts"/g)?.length,
    1,
  );
  assert.equal(repatched, patched);
});

test("Android App Actions shortcuts are rewritten to the configured package and URL scheme", () => {
  const shortcuts = `<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <capability android:name="actions.intent.OPEN_APP_FEATURE">
      <intent>
        <url-template android:value="eliza://assistant/open?source=android-app-actions{&amp;feature}" />
        <parameter android:name="feature" android:key="feature" />
      </intent>
    </capability>
    <shortcut android:shortcutId="eliza_app_action_chat">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="ai.elizaos.app.MainActivity"
        android:data="eliza://chat?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_voice">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="ai.elizaos.app.MainActivity"
        android:data="eliza://voice?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_daily_brief">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="ai.elizaos.app.MainActivity"
        android:data="eliza://lifeops/daily-brief?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_tasks">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="ai.elizaos.app.MainActivity"
        android:data="eliza://lifeops/tasks?source=android-static-shortcut" />
    </shortcut>
  </shortcuts>`;

  const patched = patchAndroidAppActionsXmlResource(shortcuts, {
    androidPackage: "com.example.pixel",
    urlScheme: "example",
  });

  assert.match(patched, /android:targetPackage="com\.example\.pixel"/);
  assert.match(patched, /android:targetClass="com\.example\.pixel\.MainActivity"/);
  assert.match(patched, /example:\/\/assistant\/open/);
  assert.match(patched, /example:\/\/chat\?source=android-static-shortcut/);
  assert.doesNotMatch(patched, /ai\.elizaos\.app\.MainActivity/);
  assert.doesNotMatch(patched, /app\.eliza"/);
  assert.doesNotMatch(patched, /eliza:\/\//);
  assert.deepEqual(
    validateAndroidAppActionsXmlResource(patched, {
      androidPackage: "com.example.pixel",
      urlScheme: "example",
    }),
    [],
  );
});

test("Android App Actions validation rejects stale package and scheme values", () => {
  const staleShortcuts = `<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <capability android:name="actions.intent.OPEN_APP_FEATURE">
      <intent>
        <url-template android:value="eliza://assistant/open?source=android-app-actions{&amp;feature}" />
      </intent>
    </capability>
    <capability android:name="actions.intent.CREATE_MESSAGE"><intent /></capability>
    <capability android:name="actions.intent.CREATE_THING"><intent /></capability>
    <capability android:name="actions.intent.GET_THING"><intent /></capability>
    <shortcut android:shortcutId="eliza_app_action_chat">
      <intent android:targetPackage="app.eliza" android:targetClass="ai.elizaos.app.MainActivity" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_voice" />
    <shortcut android:shortcutId="eliza_app_action_daily_brief" />
    <shortcut android:shortcutId="eliza_app_action_tasks">
      <intent android:data="eliza://lifeops/tasks?source=android-static-shortcut" />
    </shortcut>
  </shortcuts>`;

  const failures = validateAndroidAppActionsXmlResource(staleShortcuts, {
    androidPackage: "com.example.pixel",
    urlScheme: "example",
  });

  assert.ok(
    failures.some((failure) => failure.includes("targetPackage app.eliza")),
  );
  assert.ok(
    failures.some((failure) =>
      failure.includes("targetClass ai.elizaos.app.MainActivity"),
    ),
  );
  assert.ok(
    failures.some((failure) => failure.includes("stale literal eliza://")),
  );
});

test("Android App Actions template covers ask, chat, voice, daily brief, and tasks", () => {
  const appActionsDir = path.join(
    import.meta.dirname,
    "..",
    "platforms",
    "android",
    "app",
    "src",
    "main",
    "res",
  );
  const shortcuts = fs.readFileSync(
    path.join(appActionsDir, "xml", "shortcuts.xml"),
    "utf8",
  );
  const appActionStrings = fs.readFileSync(
    path.join(appActionsDir, "values", "android_app_actions.xml"),
    "utf8",
  );

  for (const capability of ANDROID_APP_ACTION_CAPABILITIES) {
    assert.match(shortcuts, new RegExp(`android:name="${capability}"`));
  }
  for (const shortcutId of ANDROID_APP_ACTION_SHORTCUT_IDS) {
    assert.match(shortcuts, new RegExp(`android:shortcutId="${shortcutId}"`));
  }

  assert.match(shortcuts, /eliza:\/\/chat\?source=android-app-actions&amp;action=ask/);
  assert.match(shortcuts, /eliza:\/\/chat\?source=android-app-actions&amp;action=chat/);
  assert.match(shortcuts, /eliza:\/\/voice\?source=android-static-shortcut/);
  assert.match(shortcuts, /eliza:\/\/lifeops\/daily-brief\?source=android-static-shortcut/);
  assert.match(shortcuts, /eliza:\/\/lifeops\/task\/new\?source=android-app-actions/);
  assert.match(shortcuts, /eliza:\/\/lifeops\/tasks\?source=android-static-shortcut/);

  for (const feature of ["ask", "chat", "voice", "daily brief", "tasks"]) {
    assert.match(appActionStrings, new RegExp(`<item>${feature}</item>`));
  }
});

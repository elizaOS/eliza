import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  ANDROID_APP_ACTION_CAPABILITIES,
  ANDROID_APP_ACTION_FORBIDDEN_MARKERS,
  ANDROID_APP_ACTION_REQUIRED_DEEP_LINKS,
  ANDROID_APP_ACTION_SHORTCUT_IDS,
  ensureAndroidMainActivityShortcutsMetadata,
  patchAndroidAppActionsXmlResource,
  validateAndroidAppActionsXmlResource,
} from "./run-mobile-build.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
        <url-template android:value="eliza://feature/open?source=android-app-actions{&amp;feature}" />
        <parameter android:name="feature" android:key="feature" android:required="true" />
      </intent>
      <intent>
        <url-template android:value="eliza://chat?source=android-app-actions&amp;action=chat" />
      </intent>
    </capability>
    <capability android:name="actions.intent.CREATE_MESSAGE">
      <intent>
        <url-template android:value="eliza://chat?source=android-app-actions&amp;action=ask{&amp;text}" />
      </intent>
      <intent>
        <url-template android:value="eliza://chat?source=android-app-actions&amp;action=chat" />
      </intent>
    </capability>
    <capability android:name="actions.intent.GET_THING">
      <intent>
        <url-template android:value="eliza://chat?source=android-app-actions&amp;action=ask{&amp;query}" />
      </intent>
    </capability>
    <shortcut android:shortcutId="eliza_app_action_chat">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="app.eliza.MainActivity"
        android:data="eliza://chat?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_voice">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="app.eliza.MainActivity"
        android:data="eliza://voice?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_daily_brief">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="app.eliza.MainActivity"
        android:data="eliza://lifeops/daily-brief?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_new_task">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="app.eliza.MainActivity"
        android:data="eliza://lifeops/task/new?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_tasks">
      <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="app.eliza"
        android:targetClass="app.eliza.MainActivity"
        android:data="eliza://lifeops/tasks?source=android-static-shortcut" />
    </shortcut>
  </shortcuts>`;

  const patched = patchAndroidAppActionsXmlResource(shortcuts, {
    androidPackage: "com.example.pixel",
    urlScheme: "example",
  });

  assert.match(patched, /android:targetPackage="com\.example\.pixel"/);
  assert.match(patched, /android:targetClass="com\.example\.pixel\.MainActivity"/);
  assert.match(patched, /example:\/\/feature\/open/);
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
    <capability android:name="actions.intent.GET_THING"><intent /></capability>
    <shortcut android:shortcutId="eliza_app_action_chat">
      <intent android:targetPackage="app.eliza" android:targetClass="ai.elizaos.app.MainActivity" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_voice" />
    <shortcut android:shortcutId="eliza_app_action_daily_brief" />
    <shortcut android:shortcutId="eliza_app_action_new_task" />
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

test("Android App Actions validation rejects unsupported BIIs and assistant/default-role markers", () => {
  const shortcuts = `<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <capability android:name="actions.intent.OPEN_APP_FEATURE">
      <intent>
        <url-template android:value="eliza://assistant/open?source=android-app-actions{&amp;feature}" />
      </intent>
    </capability>
    <capability android:name="actions.intent.CREATE_MESSAGE"><intent /></capability>
    <capability android:name="actions.intent.GET_THING"><intent /></capability>
    <capability android:name="actions.intent.CREATE_THING"><intent /></capability>
    <shortcut android:shortcutId="eliza_app_action_chat" />
    <shortcut android:shortcutId="eliza_app_action_voice" />
    <shortcut android:shortcutId="eliza_app_action_daily_brief" />
    <shortcut android:shortcutId="eliza_app_action_new_task" />
    <shortcut android:shortcutId="eliza_app_action_tasks" />
  </shortcuts>`;

  const failures = validateAndroidAppActionsXmlResource(shortcuts, {
    androidPackage: "app.eliza",
    urlScheme: "eliza",
  });

  assert.ok(
    failures.some((failure) =>
      failure.includes("unsupported App Action actions.intent.CREATE_THING"),
    ),
  );
  assert.ok(
    failures.some((failure) =>
      failure.includes("forbidden marker assistant/open"),
    ),
  );
});

test("Android App Actions validation requires fallback fulfillment intents", () => {
  const shortcuts = `<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <capability android:name="actions.intent.OPEN_APP_FEATURE">
      <intent>
        <url-template android:value="eliza://feature/open?source=android-app-actions{&amp;feature}" />
        <parameter android:name="feature" android:key="feature" android:required="true" />
      </intent>
    </capability>
    <capability android:name="actions.intent.CREATE_MESSAGE">
      <intent>
        <url-template android:value="eliza://chat?source=android-app-actions&amp;action=ask{&amp;text}" />
        <parameter android:name="message.text" android:key="text" android:required="true" />
      </intent>
      <intent>
        <url-template android:value="eliza://chat?source=android-app-actions&amp;action=chat" />
      </intent>
    </capability>
    <capability android:name="actions.intent.GET_THING">
      <intent>
        <url-template android:value="eliza://chat?source=android-app-actions&amp;action=ask{&amp;query}" />
        <parameter android:name="thing.name" android:key="query" android:required="true" />
      </intent>
      <intent>
        <url-template android:value="eliza://chat?source=android-app-actions&amp;action=ask" />
      </intent>
    </capability>
    <shortcut android:shortcutId="eliza_app_action_chat">
      <intent android:targetPackage="app.eliza" android:targetClass="app.eliza.MainActivity" android:data="eliza://chat?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_voice">
      <intent android:targetPackage="app.eliza" android:targetClass="app.eliza.MainActivity" android:data="eliza://voice?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_daily_brief">
      <intent android:targetPackage="app.eliza" android:targetClass="app.eliza.MainActivity" android:data="eliza://lifeops/daily-brief?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_new_task">
      <intent android:targetPackage="app.eliza" android:targetClass="app.eliza.MainActivity" android:data="eliza://lifeops/task/new?source=android-static-shortcut" />
    </shortcut>
    <shortcut android:shortcutId="eliza_app_action_tasks">
      <intent android:targetPackage="app.eliza" android:targetClass="app.eliza.MainActivity" android:data="eliza://lifeops/tasks?source=android-static-shortcut" />
    </shortcut>
  </shortcuts>`;

  const failures = validateAndroidAppActionsXmlResource(shortcuts, {
    androidPackage: "app.eliza",
    urlScheme: "eliza",
  });

  assert.ok(
    failures.some((failure) =>
      failure.includes(
        "actions.intent.OPEN_APP_FEATURE is missing a no-required-parameter fallback intent",
      ),
    ),
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

  assert.deepEqual(
    validateAndroidAppActionsXmlResource(shortcuts, {
      androidPackage: "app.eliza",
      urlScheme: "eliza",
    }),
    [],
  );
  for (const deepLink of ANDROID_APP_ACTION_REQUIRED_DEEP_LINKS) {
    assert.match(shortcuts, new RegExp(escapeRegExp(`eliza://${deepLink}`)));
  }
  for (const marker of ANDROID_APP_ACTION_FORBIDDEN_MARKERS) {
    assert.doesNotMatch(shortcuts, new RegExp(escapeRegExp(marker)));
  }

  for (const feature of ["ask", "chat", "voice", "daily brief", "new task", "tasks"]) {
    assert.match(appActionStrings, new RegExp(`<item>${feature}</item>`));
  }
});

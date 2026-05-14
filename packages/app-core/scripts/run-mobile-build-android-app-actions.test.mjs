import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureAndroidMainActivityShortcutsMetadata,
  patchAndroidAppActionsXmlResource,
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
});

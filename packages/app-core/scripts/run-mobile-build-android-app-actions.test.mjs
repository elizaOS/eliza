import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureAndroidMainActivityShortcutsMetadata,
  mergeAndroidAppActionsStringsResource,
  patchAndroidAppActionsXmlResource,
} from "./run-mobile-build.mjs";

test("Android MainActivity receives App Actions shortcuts metadata once", () => {
  const manifest = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application>
      <activity android:name=".MainActivity">
        <intent-filter>
          <action android:name="android.intent.action.MAIN" />
        </intent-filter>
      </activity>
    </application>
  </manifest>`;

  const patched = ensureAndroidMainActivityShortcutsMetadata(manifest);
  assert.match(patched, /android:name="android\.app\.shortcuts"/);
  assert.match(patched, /android:resource="@xml\/shortcuts"/);
  assert.equal(
    ensureAndroidMainActivityShortcutsMetadata(patched),
    patched,
    "metadata injection should be idempotent",
  );
});

test("Android App Actions shortcuts are rewritten to the configured package and URL scheme", () => {
  const shortcuts = `<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
    <capability android:name="actions.intent.OPEN_APP_FEATURE">
      <intent
        android:action="android.intent.action.VIEW"
        android:data="ai.elizaos.app://voice?source=android-app-actions"
        android:targetClass="ai.elizaos.app.MainActivity"
        android:targetPackage="ai.elizaos.app" />
    </capability>
  </shortcuts>`;

  const patched = patchAndroidAppActionsXmlResource(shortcuts, {
    appId: "com.example.agent",
    urlScheme: "exampleagent",
  });

  assert.match(patched, /exampleagent:\/\/voice\?source=android-app-actions/);
  assert.match(patched, /android:targetPackage="com\.example\.agent"/);
  assert.match(
    patched,
    /android:targetClass="com\.example\.agent\.MainActivity"/,
  );
  assert.doesNotMatch(patched, /ai\.elizaos\.app/);
});

test("Android App Actions strings merge into generated Capacitor strings", () => {
  const current = `<?xml version='1.0' encoding='utf-8'?>
<resources>
    <string name="app_name">Eliza</string>
    <string name="custom_url_scheme">elizaos</string>
</resources>`;
  const template = `<?xml version='1.0' encoding='utf-8'?>
<resources>
    <string name="app_name">Template</string>
    <string name="android_app_action_chat_short_label">Ask Eliza</string>
    <string-array name="android_app_action_chat_synonyms">
        <item>chat</item>
    </string-array>
</resources>`;

  const patched = mergeAndroidAppActionsStringsResource(current, template);

  assert.match(patched, /<string name="app_name">Eliza<\/string>/);
  assert.match(
    patched,
    /<string name="android_app_action_chat_short_label">Ask Eliza<\/string>/,
  );
  assert.match(patched, /<string-array name="android_app_action_chat_synonyms">/);
  assert.equal(mergeAndroidAppActionsStringsResource(patched, template), patched);
});

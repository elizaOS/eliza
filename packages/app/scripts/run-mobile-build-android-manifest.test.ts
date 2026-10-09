import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { ensureElizaClockActivityManifest } from "./mobile/android/manifest-policy.ts";

import {
  applyAndroidCleartextPolicy,
  ensureAndroidMainActivityUrlSchemeFilter,
  ensureAndroidPermissionRemovalMarkers,
  ensureElizaOsActivityFilters,
  ensureManifestApplicationClosedBeforeTopLevelEntries,
  hasAndroidPermissionRequest,
  removeAndroidPermissionRequests,
  removeApplicationComponentBlock,
  removeApplicationComponentClassBlock,
  removeXmlCommentsContaining,
  stripXmlComments,
} from "./mobile/android-manifest.ts";

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-permission android:name="android.permission.READ_SMS" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" />
    <application>
        <activity android:name="com.example.ElizaDialActivity" />
        <service android:name="com.example.ElizaAgentService">
            <intent-filter>
                <action android:name="ai.eliza.AGENT" />
            </intent-filter>
        </service>
        <activity android:name=".MainActivity">
        </activity>
    </application>
</manifest>`;

const clockReceiverActions = [
  "SET_ALARM",
  "SHOW_ALARMS",
  "SET_TIMER",
  "SHOW_TIMERS",
  "DISMISS_ALARM",
  "SNOOZE_ALARM",
];
const staleClockManifest = manifest
  .replace(
    '<activity android:name=".MainActivity">',
    `<activity android:name=".MainActivity">
    <intent-filter><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.DEFAULT" /><category android:name="android.intent.category.BROWSABLE" /><data android:scheme="elizaos" /></intent-filter>`,
  )
  .replace(
    "</application>",
    `<activity android:name="old.package.ElizaClockActivity" android:exported="true">
    ${clockReceiverActions.map((action) => `<intent-filter><action android:name="android.intent.action.${action}" /></intent-filter>`).join("\n")}
  </activity></application>`,
  );

function clockActivity(xml: string): string {
  return (
    xml.match(
      /<activity\b(?=[^>]*android:name="[^"]*ElizaClockActivity")[^>]*(?:\/>|>[\s\S]*?<\/activity>)/,
    )?.[0] ?? ""
  );
}

function assertReviewedClockEntry(xml: string) {
  const clock = clockActivity(xml);
  expect(clock).toContain('android:exported="true"');
  expect(clock).toContain("android.intent.action.MAIN");
  expect(clock).toContain("android.intent.category.LAUNCHER");
  expect(clock).not.toContain("android.intent.category.APP_CLOCK");
  for (const action of clockReceiverActions)
    expect(clock).not.toContain(`android.intent.action.${action}`);
  const queries = xml.match(/<queries\b[^>]*>[\s\S]*?<\/queries>/)?.[0];
  for (const action of [
    "SET_ALARM",
    "SHOW_ALARMS",
    "DISMISS_ALARM",
    "SNOOZE_ALARM",
  ])
    expect(queries).toContain(`android.intent.action.${action}`);
  expect(xml).toContain(
    'android:name="com.android.alarm.permission.SET_ALARM"',
  );
}

describe("Clock manifest generation ownership", () => {
  it("replaces stale receivers with the template entry and keeps existing deep links", () => {
    const template = `<manifest><application>
      <activity android:name="ai.elizaos.app.ElizaClockActivity" android:exported="true">
        <intent-filter><action android:name="android.intent.action.MAIN" /><category android:name="android.intent.category.LAUNCHER" /></intent-filter>
        <intent-filter><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.BROWSABLE" /><data android:scheme="elizaos" android:host="clock" /></intent-filter>
      </activity>
    </application></manifest>`;
    const generated = ensureElizaClockActivityManifest(
      staleClockManifest,
      "ai.elizaos.app.fixture",
      { templateXml: template },
    );
    assertReviewedClockEntry(generated);
    expect(clockActivity(generated)).toContain(
      'android:scheme="elizaos" android:host="clock"',
    );
    expect(generated).toContain(
      'android:name="ai.elizaos.app.fixture.ElizaClockActivity"',
    );
    expect(
      generated.match(/android:name="[^"]*ElizaClockActivity"/g),
    ).toHaveLength(1);
    expect(
      clockActivity(
        ensureElizaClockActivityManifest(generated, "ai.elizaos.app.fixture", {
          templateXml: template,
        }),
      ),
    ).toBe(clockActivity(generated));
  });

  it("keeps the same app-entry and external Clock contract when no template component exists", () => {
    const generated = ensureElizaClockActivityManifest(
      staleClockManifest,
      "ai.elizaos.app.fixture",
      { templateXml: manifest },
    );
    assertReviewedClockEntry(generated);
    expect(generated).toContain('android:name=".MainActivity"');
    expect(
      ensureElizaClockActivityManifest(generated, "ai.elizaos.app.fixture", {
        javaAvailable: false,
      }),
    ).not.toContain("ElizaClockActivity");
  });

  it.each([
    { templatePresent: true, includeAospRoleLaunchers: false },
    { templatePresent: true, includeAospRoleLaunchers: true },
    { templatePresent: false, includeAospRoleLaunchers: false },
    { templatePresent: false, includeAospRoleLaunchers: true },
  ])(
    "generates the Clock app entry with template=$templatePresent and AOSP role launchers=$includeAospRoleLaunchers",
    ({ templatePresent, includeAospRoleLaunchers }) => {
      const root = fs.mkdtempSync(
        path.join(os.tmpdir(), "eliza-clock-overlay-"),
      );
      try {
        const app = path.join(root, "packages/app");
        const manifestPath = path.join(
          app,
          "android/app/src/main/AndroidManifest.xml",
        );
        fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
        fs.writeFileSync(
          path.join(app, "package.json"),
          '{"name":"clock-fixture","private":true}',
        );
        fs.writeFileSync(
          path.join(app, "app.config.ts"),
          'export default { appId: "ai.elizaos.app.fixture", appName: "Clock fixture", urlScheme: "elizaos" };',
        );
        fs.writeFileSync(manifestPath, staleClockManifest);
        const overlayUrl = new URL(
          "./mobile/android/overlay.ts",
          import.meta.url,
        ).href;
        const templatePath = fileURLToPath(
          new URL(
            "../platforms/android/app/src/main/AndroidManifest.xml",
            import.meta.url,
          ),
        );
        const result = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import fs from "node:fs"; const exists = fs.existsSync; fs.existsSync = (file) => ${templatePresent} || String(file) !== ${JSON.stringify(templatePath)} ? exists(file) : false; const { overlayAndroid } = await import(${JSON.stringify(overlayUrl)}); overlayAndroid({ includeAospRoleLaunchers: ${includeAospRoleLaunchers}, includeHomeRole: false });`,
          ],
          {
            env: {
              ...process.env,
              ELIZA_MOBILE_REPO_ROOT: root,
              ELIZA_ANDROID_USE_APP_DIR: "1",
              ELIZA_APP_ID: "ai.elizaos.app.fixture",
              ELIZA_APP_NAME: "Clock fixture",
              ELIZA_APP_URL_SCHEME: "elizaos",
              ELIZA_WHITELABEL_DIR: "",
            },
            encoding: "utf8",
            timeout: 30000,
          },
        );
        expect(result.status, result.stderr).toBe(0);
        const generated = fs.readFileSync(manifestPath, "utf8");
        assertReviewedClockEntry(generated);
        const proofPath = testOutputPath(
          "android-clock-manifest-owner",
          `generated-template-${templatePresent}-aosp-${includeAospRoleLaunchers}.xml`,
        );
        fs.mkdirSync(path.dirname(proofPath), { recursive: true });
        fs.writeFileSync(proofPath, generated);
        const main = generated.match(
          /<activity\b(?=[^>]*android:name="\.MainActivity")[\s\S]*?<\/activity>/,
        )?.[0];
        expect(main).toContain('android:scheme="elizaos"');
        const template = fs.readFileSync(
          fileURLToPath(
            new URL(
              "../platforms/android/app/src/main/AndroidManifest.xml",
              import.meta.url,
            ),
          ),
          "utf8",
        );
        if (templatePresent)
          expect(clockActivity(generated)).toBe(
            clockActivity(template).replace(
              'android:name="ai.elizaos.app.ElizaClockActivity"',
              'android:name="ai.elizaos.app.fixture.ElizaClockActivity"',
            ),
          );
        const sourceJava = fileURLToPath(
          new URL(
            "../platforms/android/app/src/main/java/ai/elizaos/app",
            import.meta.url,
          ),
        );
        const activeJava = path.join(
          app,
          "android/app/src/main/java/ai/elizaos/app/fixture",
        );
        const sanitized = spawnSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `import fs from "node:fs"; const exists = fs.existsSync; fs.existsSync = (file) => [${JSON.stringify(sourceJava)}, ${JSON.stringify(activeJava)}].includes(String(file)) ? false : exists(file); const { sanitizeAndroidManifestWhenPlatformTemplatesMissing } = await import(${JSON.stringify(overlayUrl)}); sanitizeAndroidManifestWhenPlatformTemplatesMissing();`,
          ],
          {
            env: {
              ...process.env,
              ELIZA_MOBILE_REPO_ROOT: root,
              ELIZA_ANDROID_USE_APP_DIR: "1",
              ELIZA_APP_ID: "ai.elizaos.app.fixture",
              ELIZA_APP_NAME: "Clock fixture",
              ELIZA_APP_URL_SCHEME: "elizaos",
              ELIZA_WHITELABEL_DIR: "",
            },
            encoding: "utf8",
            timeout: 30000,
          },
        );
        expect(sanitized.status, sanitized.stderr).toBe(0);
        const withoutJava = fs.readFileSync(manifestPath, "utf8");
        expect(withoutJava).not.toContain("ElizaClockActivity");
        expect(withoutJava).toContain('android:scheme="elizaos"');
        expect(withoutJava).toContain(
          'android:name="com.android.alarm.permission.SET_ALARM"',
        );
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe("Android manifest XML helpers", () => {
  it("removes exact and package-relative component blocks", () => {
    const withoutAgent = removeApplicationComponentBlock(
      manifest,
      "com.example.ElizaAgentService",
    );
    const withoutDial = removeApplicationComponentClassBlock(
      withoutAgent,
      "ElizaDialActivity",
    );

    expect(withoutDial).not.toContain("ElizaAgentService");
    expect(withoutDial).not.toContain("ElizaDialActivity");
    expect(withoutDial).toContain(".MainActivity");
  });

  it("removes active permission requests but preserves tools removal markers", () => {
    const withMarker = ensureAndroidPermissionRemovalMarkers(manifest, [
      "READ_SMS",
    ]);
    const stripped = removeAndroidPermissionRequests(withMarker, ["READ_SMS"]);

    expect(stripped).toContain(
      'xmlns:tools="http://schemas.android.com/tools"',
    );
    expect(stripped).toContain(
      'android:name="android.permission.READ_SMS" tools:node="remove"',
    );
    expect(
      hasAndroidPermissionRequest(stripped, "android.permission.READ_SMS"),
    ).toBe(false);
    expect(
      hasAndroidPermissionRequest(
        stripped,
        "android.permission.ACCESS_FINE_LOCATION",
      ),
    ).toBe(true);
  });

  it("closes application before top-level manifest entries when a merge leaves it open", () => {
    const malformed = `<manifest>
    <application>
    <uses-permission android:name="android.permission.CAMERA" />
</manifest>`;

    expect(
      ensureManifestApplicationClosedBeforeTopLevelEntries(malformed),
    ).toContain("</application>\n\n    <uses-permission");
  });

  it("applies cleartext policy and MainActivity filters idempotently", () => {
    const cleartext = applyAndroidCleartextPolicy(manifest, {
      allowCleartext: false,
    });
    const withHome = ensureElizaOsActivityFilters(cleartext, { enabled: true });
    const withoutHome = ensureElizaOsActivityFilters(withHome, {
      enabled: false,
    });
    const withScheme = ensureAndroidMainActivityUrlSchemeFilter(withoutHome, {
      urlScheme: "example",
    });

    expect(cleartext).toContain('android:usesCleartextTraffic="false"');
    expect(withHome).toContain("android.intent.category.HOME");
    expect(withoutHome).not.toContain("android.intent.category.HOME");
    expect(withScheme).toContain("android.intent.action.VIEW");
    expect(
      ensureAndroidMainActivityUrlSchemeFilter(withScheme, {
        urlScheme: "example",
      }),
    ).toBe(withScheme);
  });

  it("strips comments containing removed markers before source audits", () => {
    const xml = `<!-- ElizaAgentService legacy note -->
<manifest><!-- keep me --></manifest>`;

    expect(
      removeXmlCommentsContaining(xml, ["ElizaAgentService"]),
    ).not.toContain("ElizaAgentService");
    expect(stripXmlComments(xml)).toBe("\n<manifest></manifest>");
  });

  it("does not swallow real markup between two separate comments (regression #14408)", () => {
    // Reproduces the android-cloud pre-gradle audit failure: an earlier
    // comment, then real markup we must keep (the MainActivity @xml/shortcuts
    // meta-data), then a later descriptive comment that MENTIONS the stripped
    // marker. The unbounded `[\s\S]*?` regex matched from the first `<!--`
    // across the closing `-->` into the second comment, deleting the shortcuts
    // registration in between and tripping the "does not register @xml/shortcuts"
    // audit failure.
    const xml = `<!-- leading note, no marker here -->
<application>
    <meta-data
        android:name="android.app.shortcuts"
        android:resource="@xml/shortcuts" />
    <!-- descriptive note that references ElizaAssistActivity fallback flow -->
    <activity android:name=".MainActivity" />
</application>`;

    const stripped = removeXmlCommentsContaining(xml, ["ElizaAssistActivity"]);

    // The real shortcuts meta-data between the two comments must survive.
    expect(stripped).toContain('android:name="android.app.shortcuts"');
    expect(stripped).toContain("@xml/shortcuts");
    expect(stripped).toContain(".MainActivity");
    // The leading comment (no marker) must survive untouched.
    expect(stripped).toContain("leading note, no marker here");
    // Only the comment that actually contains the marker is removed.
    expect(stripped).not.toContain("ElizaAssistActivity");
  });
});

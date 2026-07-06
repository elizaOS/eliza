/** Exercises run mobile build android manifest behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";

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
} from "./mobile/android-manifest.mjs";

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

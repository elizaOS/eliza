/**
 * Verifies Android browser-handoff evidence is bound to the resumed activity,
 * not unrelated Chrome text elsewhere in the activity-manager dump.
 */

import { describe, expect, it } from "vitest";
import {
  ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY,
  resumedAndroidActivityComponent,
} from "./resumed-android-activity";

describe("resumedAndroidActivityComponent", () => {
  it("accepts Chrome and Capacitor Browser controller as resumed activities", () => {
    const chrome = resumedAndroidActivityComponent(`
      topResumedActivity=ActivityRecord{abcd u0 com.android.chrome/com.google.android.apps.chrome.Main t24}
    `);
    const browserController = resumedAndroidActivityComponent(`
      mResumedActivity: ActivityRecord{ef01 u0 ai.elizaos.app/com.capacitorjs.plugins.browser.BrowserControllerActivity t23}
    `);

    expect(chrome).toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);
    expect(browserController).toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);
  });

  it("rejects background Chrome service text while Eliza remains resumed", () => {
    const activityDump = `
      topResumedActivity=ActivityRecord{deb8e5 u0 ai.elizaos.app/.MainActivity t23}
      * Hist #0: ActivityRecord{deb8e5 u0 ai.elizaos.app/.MainActivity t23}
        connections={ConnectionRecord{7d994ad u0 CR WPRI com.android.chrome/org.chromium.chrome.browser.customtabs.CustomTabsConnectionService:@7cf1dc4 flags=0x21}}
    `;

    const resumed = resumedAndroidActivityComponent(activityDump);
    expect(resumed).toBe("ai.elizaos.app/.MainActivity");
    expect(resumed).not.toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);
  });

  it("rejects a lookalike app's Browser controller activity", () => {
    const lookalike = resumedAndroidActivityComponent(`
      mResumedActivity: ActivityRecord{ef01 u0 evil.lookalike/com.capacitorjs.plugins.browser.BrowserControllerActivity t23}
    `);

    expect(lookalike).toBe(
      "evil.lookalike/com.capacitorjs.plugins.browser.BrowserControllerActivity",
    );
    expect(lookalike).not.toMatch(ANDROID_CLOUD_SIGN_IN_RESUMED_ACTIVITY);
  });

  it("returns null when activity manager reports no resumed component", () => {
    expect(
      resumedAndroidActivityComponent(
        "connections={ConnectionRecord com.android.chrome/CustomTabsConnectionService}",
      ),
    ).toBeNull();
  });
});

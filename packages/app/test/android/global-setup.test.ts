/** Verifies the Android route lane pre-grants permissions requested by mounted app views. */

import { describe, expect, it } from "vitest";
import { ANDROID_E2E_RUNTIME_PERMISSIONS } from "./global-setup";

describe("Android device-e2e runtime permissions", () => {
  it("pre-grants the complete phone permission request before route coverage", () => {
    expect(ANDROID_E2E_RUNTIME_PERMISSIONS).toEqual(
      expect.arrayContaining([
        "android.permission.CALL_PHONE",
        "android.permission.READ_CALL_LOG",
        "android.permission.READ_PHONE_STATE",
      ]),
    );
  });
});

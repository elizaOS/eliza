// @vitest-environment jsdom
/**
 * Pins the user-agent regex used by `isMiladyOS()` to distinguish the AOSP
 * MiladyOS variant from the same APK installed on a stock Android phone.
 *
 * `MainActivity` appends `MiladyOS/<tag>` to the WebView user-agent when
 * `ro.miladyos.product` is present (set by `vendor/milady/milady_common.mk`).
 * The vanilla APK leaves the UA untouched. The match must be tight enough
 * that benign substrings (`MiladyOSlike/...`, `NotMiladyOSReally/...`) do
 * not flip a stock phone into the picker-bypass branch.
 *
 * This file tests the regex directly via the exported helper. The full
 * gate (`isAndroid && marker`) is exercised by `RuntimeGate.test.tsx` via
 * mocks of the platform module.
 */

import { describe, expect, it } from "vitest";
import { userAgentHasMiladyOSMarker } from "../../src/platform/init";

describe("userAgentHasMiladyOSMarker", () => {
  it("matches the Cuttlefish AOSP user-agent suffix", () => {
    expect(
      userAgentHasMiladyOSMarker(
        "Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64 Build/UPB4.230623.005) MiladyOS/cf_x86_64",
      ),
    ).toBe(true);
  });

  it("matches a Pixel-style UA with a different MiladyOS tag", () => {
    expect(
      userAgentHasMiladyOSMarker(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041) MiladyOS/shiba_phone",
      ),
    ).toBe(true);
  });

  it("rejects a stock Android user-agent with no MiladyOS suffix", () => {
    expect(
      userAgentHasMiladyOSMarker(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041) AppleWebKit/537.36",
      ),
    ).toBe(false);
  });

  it("rejects substrings that do not have a slash directly after MiladyOS", () => {
    expect(
      userAgentHasMiladyOSMarker(
        "Mozilla/5.0 (Linux; Android 14) MiladyOSlike/foo NotMiladyOSReally/bar",
      ),
    ).toBe(false);
  });

  it("rejects an empty user-agent", () => {
    expect(userAgentHasMiladyOSMarker("")).toBe(false);
  });

  it("matches even when MiladyOS appears mid-UA, not just as a suffix", () => {
    // The MainActivity appends, but other layers might prepend. The token
    // form is `MiladyOS/<tag>` regardless of position.
    expect(
      userAgentHasMiladyOSMarker(
        "Mozilla/5.0 MiladyOS/cf_x86_64 (Linux; Android 14)",
      ),
    ).toBe(true);
  });
});

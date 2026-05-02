// @vitest-environment jsdom
/**
 * Pins the user-agent regex used by `isElizaOS()` to distinguish the AOSP
 * ElizaOS variant from the same APK installed on a stock Android phone.
 *
 * `MainActivity` appends `ElizaOS/<tag>` to the WebView user-agent when
 * `ro.elizaos.product` is present (set by `vendor/eliza/eliza_common.mk`).
 * The vanilla APK leaves the UA untouched. The match must be tight enough
 * that benign substrings (`ElizaOSlike/...`, `NotElizaOSReally/...`) do
 * not flip a stock phone into the picker-bypass branch.
 *
 * This file tests the regex directly via the exported helper. The full
 * gate (`isAndroid && marker`) is exercised by `RuntimeGate.test.tsx` via
 * mocks of the platform module.
 */

import { describe, expect, it } from "vitest";
import { userAgentHasElizaOSMarker } from "../../src/platform/init";

describe("userAgentHasElizaOSMarker", () => {
  it("matches the Cuttlefish AOSP user-agent suffix", () => {
    expect(
      userAgentHasElizaOSMarker(
        "Mozilla/5.0 (Linux; Android 14; sdk_gphone64_x86_64 Build/UPB4.230623.005) ElizaOS/cf_x86_64",
      ),
    ).toBe(true);
  });

  it("matches a Pixel-style UA with a different ElizaOS tag", () => {
    expect(
      userAgentHasElizaOSMarker(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041) ElizaOS/shiba_phone",
      ),
    ).toBe(true);
  });

  it("rejects a stock Android user-agent with no ElizaOS suffix", () => {
    expect(
      userAgentHasElizaOSMarker(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UD1A.230803.041) AppleWebKit/537.36",
      ),
    ).toBe(false);
  });

  it("rejects substrings that do not have a slash directly after ElizaOS", () => {
    expect(
      userAgentHasElizaOSMarker(
        "Mozilla/5.0 (Linux; Android 14) ElizaOSlike/foo NotElizaOSReally/bar",
      ),
    ).toBe(false);
  });

  it("rejects an empty user-agent", () => {
    expect(userAgentHasElizaOSMarker("")).toBe(false);
  });

  it("matches even when ElizaOS appears mid-UA, not just as a suffix", () => {
    // The MainActivity appends, but other layers might prepend. The token
    // form is `ElizaOS/<tag>` regardless of position.
    expect(
      userAgentHasElizaOSMarker(
        "Mozilla/5.0 ElizaOS/cf_x86_64 (Linux; Android 14)",
      ),
    ).toBe(true);
  });
});

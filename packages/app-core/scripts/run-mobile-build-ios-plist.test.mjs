/** Exercises run mobile build ios plist behavior with deterministic app-core test fixtures. */
import { describe, expect, it } from "vitest";

import {
  ensurePlistArrayStrings,
  IOS_APNS_ENABLED_KEY,
  mergeIosInfoPlist,
  readIosApnsBuildFlag,
  replaceOrInsertPlistString,
  resolveIosPermissionKeys,
} from "./mobile/ios-plist.mjs";

const minimalPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
</dict>
</plist>`;

describe("iOS Info.plist overlay helpers", () => {
  it("merges the complete elizaOS plist overlay into a minimal plist", () => {
    const merged = mergeIosInfoPlist(minimalPlist, {
      appName: "Eliza",
      urlScheme: "eliza",
    });

    expect(merged.changed).toBe(true);
    expect(merged.content).toContain(
      "<key>CFBundleDisplayName</key>\n\t<string>$(ELIZA_DISPLAY_NAME)</string>",
    );
    for (const [key, description] of resolveIosPermissionKeys({
      appName: "Eliza",
    })) {
      expect(merged.content).toContain(`<key>${key}</key>`);
      expect(merged.content).toContain(`<string>${description}</string>`);
    }
    expect(merged.content).toContain("<key>NSBonjourServices</key>");
    expect(merged.content).toContain("<string>_eliza-gw._tcp</string>");
    expect(merged.content).toContain("<key>UIBackgroundModes</key>");
    expect(merged.content).toContain("<string>audio</string>");
    expect(merged.content).toContain("<string>fetch</string>");
    expect(merged.content).toContain("<string>processing</string>");
    expect(merged.content).toContain(
      "<key>BGTaskSchedulerPermittedIdentifiers</key>",
    );
    expect(merged.content).toContain("<string>ai.eliza.tasks.refresh</string>");
    expect(merged.content).toContain("<key>CFBundleURLTypes</key>");
    expect(merged.content).toContain("<string>eliza</string>");
    expect(merged.content).toMatch(
      new RegExp(`<key>${IOS_APNS_ENABLED_KEY}</key>\\s*<string>0</string>`),
    );
  });

  it("writes the native APNs gate from the canonical build option", () => {
    const enabled = mergeIosInfoPlist(minimalPlist, {
      appName: "Eliza",
      urlScheme: "eliza",
      apnsEnabled: true,
    });

    expect(enabled.content).toMatch(
      new RegExp(`<key>${IOS_APNS_ENABLED_KEY}</key>\\s*<string>1</string>`),
    );
    expect(
      mergeIosInfoPlist(enabled.content, {
        appName: "Eliza",
        urlScheme: "eliza",
        apnsEnabled: false,
      }).content,
    ).toMatch(
      new RegExp(`<key>${IOS_APNS_ENABLED_KEY}</key>\\s*<string>0</string>`),
    );
  });

  it("accepts only the exact renderer-compatible APNs build flag", () => {
    expect(readIosApnsBuildFlag(undefined)).toBe(false);
    expect(readIosApnsBuildFlag("")).toBe(false);
    expect(readIosApnsBuildFlag("0")).toBe(false);
    expect(readIosApnsBuildFlag("1")).toBe(true);
    expect(() => readIosApnsBuildFlag(" 1 ")).toThrow(/must be "0" or "1"/);
    expect(() => readIosApnsBuildFlag("true")).toThrow(/must be "0" or "1"/);
  });

  it("is idempotent after the first merge", () => {
    const first = mergeIosInfoPlist(minimalPlist, {
      appName: "Eliza",
      urlScheme: "eliza",
    });
    const second = mergeIosInfoPlist(first.content, {
      appName: "Eliza",
      urlScheme: "eliza",
    });

    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });

  it("appends missing array values without duplicating existing ones", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>UIBackgroundModes</key>
	<array>
		<string>fetch</string>
	</array>
</dict>
</plist>`;

    const merged = ensurePlistArrayStrings(plist, "UIBackgroundModes", [
      "fetch",
      "processing",
      "remote-notification",
    ]);

    expect(merged.match(/<string>fetch<\/string>/g)).toHaveLength(1);
    expect(merged).toContain("<string>processing</string>");
    expect(merged).toContain("<string>remote-notification</string>");
  });

  it("updates an existing string and escapes XML text", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>Old</string>
</dict>
</plist>`;

    const patched = replaceOrInsertPlistString(
      plist,
      "CFBundleDisplayName",
      "Eliza & Friends <Beta>",
    );

    expect(patched).toContain(
      "<string>Eliza &amp; Friends &lt;Beta&gt;</string>",
    );
    expect(patched).not.toContain("<string>Old</string>");
  });
});

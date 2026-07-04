/**
 * Unit tests for the Patch Ios Plist app packaging script behavior and
 * platform guardrails.
 */
import { describe, expect, it } from "vitest";

import { ensurePlistUrlScheme } from "../../app-core/scripts/lib/ios-plist-url-scheme.mjs";
import { hasKey, KEYS, patchPlist } from "./patch-ios-plist.mjs";

const MINIMAL_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>Eliza</string>
</dict>
</plist>
`;

describe("patch-ios-plist", () => {
  it("inserts every required key on the first patch", () => {
    const { next, changed } = patchPlist(MINIMAL_PLIST, "elizaos");
    expect(changed).toBe(true);
    for (const entry of KEYS) {
      expect(hasKey(next, entry.key)).toBe(true);
    }
    expect(hasKey(next, "CFBundleURLTypes")).toBe(true);
    expect(next).toContain("<string>elizaos</string>");
    expect(next).toContain("<string>audio</string>");
    expect(next).toContain("NSMicrophoneUsageDescription");
    expect(next).toContain("NSSpeechRecognitionUsageDescription");
  });

  it("is idempotent — no changes on the second patch", () => {
    const first = patchPlist(MINIMAL_PLIST, "elizaos");
    const second = patchPlist(first.next, "elizaos");
    expect(second.changed).toBe(false);
    expect(second.next).toBe(first.next);
  });

  it("adds audio when UIBackgroundModes already exists with other modes", () => {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>UIBackgroundModes</key>
\t<array>
\t\t<string>fetch</string>
\t\t<string>processing</string>
\t</array>
</dict>
</plist>
`;
    const { next, changed } = patchPlist(plist, "elizaos");
    expect(changed).toBe(true);
    expect(next).toMatch(
      /<key>UIBackgroundModes<\/key>\s*<array>[\s\S]*<string>fetch<\/string>[\s\S]*<string>processing<\/string>[\s\S]*<string>audio<\/string>[\s\S]*<\/array>/,
    );
  });

  it("does not modify keys it doesn't own", () => {
    const { next } = patchPlist(MINIMAL_PLIST, "elizaos");
    expect(next).toContain("<key>CFBundleName</key>");
    expect(next).toContain("<string>Eliza</string>");
  });

  it("adds the URL scheme to an existing CFBundleURLTypes array", () => {
    const plist = patchPlist(MINIMAL_PLIST, "other").next;
    const { next, changed } = patchPlist(plist, "elizaos");
    expect(changed).toBe(true);
    expect(next).toContain("<string>other</string>");
    expect(next).toContain("<string>elizaos</string>");
    expect(next).toMatch(
      /<key>CFBundleURLTypes<\/key>\s*<array>[\s\S]*<dict>[\s\S]*<string>other<\/string>[\s\S]*<\/dict>[\s\S]*<dict>[\s\S]*<string>elizaos<\/string>[\s\S]*<\/dict>[\s\S]*<\/array>/,
    );
    const schemeArrays = Array.from(
      next.matchAll(
        /<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/g,
      ),
    );
    expect(schemeArrays).toHaveLength(2);
    for (const [, schemesBody] of schemeArrays) {
      expect(schemesBody).not.toContain("<dict>");
    }
  });

  it("throws when the input has no top-level </dict></plist>", () => {
    expect(() => patchPlist("<plist></plist>", "elizaos")).toThrow(
      /could not locate top-level/,
    );
  });

  it("throws instead of silently skipping URL scheme insertion on malformed plist XML", () => {
    expect(() => ensurePlistUrlScheme("<plist></plist>", "elizaos")).toThrow(
      /could not locate top-level/,
    );
  });
});

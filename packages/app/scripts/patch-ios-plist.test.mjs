import { describe, expect, it } from "vitest";

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
    const { next, changed } = patchPlist(MINIMAL_PLIST);
    expect(changed).toBe(true);
    for (const entry of KEYS) {
      expect(hasKey(next, entry.key)).toBe(true);
    }
    expect(next).toContain("<string>audio</string>");
    expect(next).toContain("NSMicrophoneUsageDescription");
    expect(next).toContain("NSSpeechRecognitionUsageDescription");
  });

  it("is idempotent — no changes on the second patch", () => {
    const first = patchPlist(MINIMAL_PLIST);
    const second = patchPlist(first.next);
    expect(second.changed).toBe(false);
    expect(second.next).toBe(first.next);
  });

  it("does not modify keys it doesn't own", () => {
    const { next } = patchPlist(MINIMAL_PLIST);
    expect(next).toContain("<key>CFBundleName</key>");
    expect(next).toContain("<string>Eliza</string>");
  });

  it("throws when the input has no top-level </dict></plist>", () => {
    expect(() => patchPlist("<plist></plist>")).toThrow(
      /could not locate top-level/,
    );
  });
});

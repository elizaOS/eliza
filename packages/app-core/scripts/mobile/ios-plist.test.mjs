import { describe, expect, it } from "vitest";

import { escapeRegExp, escapeXmlText } from "./escape.mjs";
import {
  ensurePlistArrayStrings,
  insertBeforeRootPlistDictClose,
  removePbxListEntries,
  replaceIosAppGroupPlaceholders,
  replaceOrInsertPlistString,
} from "./ios-plist.mjs";

// These pure transformers were extracted verbatim out of the 7.8k-line
// run-mobile-build.mjs spine (#10096 item 2). The orchestrators that call them
// run real Gradle/Xcode builds and have no unit coverage, but the transformers
// themselves are deterministic string functions — so they get locked here so a
// regression in the decomposition is caught without a device build.

const PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleName</key>
\t<string>Eliza</string>
</dict>
</plist>`;

describe("escape leaf utilities", () => {
  it("escapeXmlText escapes the XML-significant characters", () => {
    expect(escapeXmlText("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("escapeXmlText escapes ampersands before angle brackets (no double-escape)", () => {
    expect(escapeXmlText("<&>")).toBe("&lt;&amp;&gt;");
  });

  it("escapeRegExp neutralizes regex metacharacters", () => {
    const escaped = escapeRegExp("a.b+c(d)");
    expect(new RegExp(escaped).test("a.b+c(d)")).toBe(true);
    expect(new RegExp(escaped).test("axbxcxd")).toBe(false);
  });
});

describe("replaceOrInsertPlistString", () => {
  it("replaces the value of an existing key", () => {
    const out = replaceOrInsertPlistString(PLIST, "CFBundleName", "Test App");
    expect(out).toContain(
      "<key>CFBundleName</key>\n\t<string>Test App</string>",
    );
    expect(out).not.toContain("<string>Eliza</string>");
  });

  it("inserts a new key/string before </dict> when absent", () => {
    const out = replaceOrInsertPlistString(PLIST, "NewKey", "NewValue");
    expect(out).toContain("<key>NewKey</key>");
    expect(out).toContain("<string>NewValue</string>");
  });

  it("escapes the inserted value", () => {
    const out = replaceOrInsertPlistString(PLIST, "CFBundleName", "A & B");
    expect(out).toContain("<string>A &amp; B</string>");
  });
});

describe("ensurePlistArrayStrings", () => {
  it("creates the array when the key is missing", () => {
    const out = ensurePlistArrayStrings(PLIST, "Modes", ["a", "b"]);
    expect(out).toContain("<key>Modes</key>");
    expect(out).toContain("<string>a</string>");
    expect(out).toContain("<string>b</string>");
  });

  it("appends only missing entries to an existing array (idempotent)", () => {
    const withArray = ensurePlistArrayStrings(PLIST, "Modes", ["a"]);
    const out = ensurePlistArrayStrings(withArray, "Modes", ["a", "b"]);
    expect(out.match(/<string>a<\/string>/g)).toHaveLength(1);
    expect(out).toContain("<string>b</string>");
  });
});

describe("insertBeforeRootPlistDictClose", () => {
  it("inserts before the root </dict></plist>, not a nested one", () => {
    const nested = `<plist version="1.0">
<dict>
\t<key>Inner</key>
\t<dict>
\t\t<key>X</key>
\t\t<string>1</string>
\t</dict>
</dict>
</plist>`;
    const out = insertBeforeRootPlistDictClose(nested, "\t<key>Added</key>");
    // The injected key lands after the inner dict closes, before the root dict.
    expect(out.indexOf("<key>Added</key>")).toBeGreaterThan(
      out.indexOf("<key>X</key>"),
    );
    expect(out.endsWith("</plist>")).toBe(true);
  });
});

describe("replaceIosAppGroupPlaceholders", () => {
  it("rewrites known placeholder app groups to the build app group", () => {
    const src = "group.ai.elizaos.app and group.app.eliza";
    const out = replaceIosAppGroupPlaceholders(src, "group.custom.app");
    expect(out).toBe("group.custom.app and group.custom.app");
  });

  it("leaves unrelated group ids untouched", () => {
    const src = "group.com.other.thing";
    expect(replaceIosAppGroupPlaceholders(src, "group.custom.app")).toBe(src);
  });
});

describe("removePbxListEntries", () => {
  it("removes the named id lines from a pbxproj list section", () => {
    const pbx = `\n\t\tAAAA1111 /* Foo.swift */,\n\t\tBBBB2222 /* Bar.swift */,`;
    const out = removePbxListEntries(pbx, ["AAAA1111"]);
    expect(out).not.toContain("AAAA1111");
    expect(out).toContain("BBBB2222 /* Bar.swift */,");
  });
});

/**
 * Self-tests for mas-smoke.mjs.
 *
 * Covers the pure-data helpers:
 *   - parseEntitlementsPlist: extracts true/false/string from plist XML
 *   - walkBundleFiles / isMachO / findMachOFiles: identifies Mach-O files in a
 *     synthetic bundle tree by magic bytes
 *
 * Does NOT shell out to codesign — that requires a real signed bundle and
 * lives in the launch verification step.
 *
 * Runs under node:test (see run-mobile-build-policy.test.mjs for the same
 * pattern). Excluded from vitest in packages/app-core/vitest.config.ts.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  findMachOFiles,
  isMachO,
  parseEntitlementsPlist,
  walkBundleFiles,
} from "./mas-smoke.mjs";

const SAMPLE_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.app-sandbox</key>
  <true/>
  <key>com.apple.security.network.client</key>
  <true/>
  <key>com.apple.security.cs.allow-jit</key>
  <false/>
  <key>aps-environment</key>
  <string>production</string>
</dict>
</plist>`;

test("parseEntitlementsPlist extracts true/false and string values", () => {
  const ents = parseEntitlementsPlist(SAMPLE_PLIST);
  assert.equal(ents.get("com.apple.security.app-sandbox"), true);
  assert.equal(ents.get("com.apple.security.network.client"), true);
  assert.equal(ents.get("com.apple.security.cs.allow-jit"), false);
  assert.equal(ents.get("aps-environment"), "production");
});

test("parseEntitlementsPlist treats missing keys as absent (not false)", () => {
  const ents = parseEntitlementsPlist(SAMPLE_PLIST);
  assert.equal(
    ents.has("com.apple.security.cs.disable-library-validation"),
    false,
  );
  assert.equal(
    ents.has("com.apple.security.cs.allow-unsigned-executable-memory"),
    false,
  );
  // Caller distinguishes "absent" from "false" via .has().
  assert.equal(
    ents.get("com.apple.security.cs.disable-library-validation"),
    undefined,
  );
});

test("parseEntitlementsPlist handles single-line plist XML (codesign --xml output)", () => {
  // codesign emits the plist as a single line on stdout.
  const oneLine = SAMPLE_PLIST.replace(/\n\s*/g, "");
  const ents = parseEntitlementsPlist(oneLine);
  assert.equal(ents.get("com.apple.security.app-sandbox"), true);
  assert.equal(ents.get("aps-environment"), "production");
});

test("parseEntitlementsPlist returns empty Map on empty input", () => {
  const ents = parseEntitlementsPlist("");
  assert.equal(ents.size, 0);
});

test("parseEntitlementsPlist decodes XML entities in keys and string values", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>com.apple.foo&amp;bar</key>
  <string>a &quot;quoted&quot; &amp; thing</string>
</dict>
</plist>`;
  const ents = parseEntitlementsPlist(xml);
  assert.equal(ents.has("com.apple.foo&bar"), true);
  assert.equal(ents.get("com.apple.foo&bar"), 'a "quoted" & thing');
});

// Bytes for a 64-bit little-endian Mach-O magic (0xfeedfacf in big-endian wire order).
// isMachO reads 4 bytes and `readUInt32BE` against that buffer, so writing
// these bytes literally produces a "matching" file.
const MACHO_HEADER_64 = Buffer.from([0xfe, 0xed, 0xfa, 0xcf]);
const MACHO_HEADER_FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const NOT_MACHO = Buffer.from("hello world\n", "utf8");

test("isMachO detects 64-bit Mach-O magic", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mas-smoke-"));
  try {
    const machoPath = path.join(dir, "fake-binary");
    writeFileSync(machoPath, MACHO_HEADER_64);
    assert.equal(isMachO(machoPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isMachO detects fat (universal) Mach-O magic", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mas-smoke-"));
  try {
    const machoPath = path.join(dir, "fat-binary");
    writeFileSync(machoPath, MACHO_HEADER_FAT);
    assert.equal(isMachO(machoPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isMachO returns false on non-Mach-O files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mas-smoke-"));
  try {
    const textPath = path.join(dir, "readme.txt");
    writeFileSync(textPath, NOT_MACHO);
    assert.equal(isMachO(textPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isMachO returns false on tiny files (too small for magic)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mas-smoke-"));
  try {
    const tinyPath = path.join(dir, "tiny");
    writeFileSync(tinyPath, Buffer.from([0xfe, 0xed])); // only 2 bytes
    assert.equal(isMachO(tinyPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("walkBundleFiles enumerates files recursively, skipping directories", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mas-smoke-"));
  try {
    mkdirSync(path.join(dir, "Contents", "MacOS"), { recursive: true });
    mkdirSync(path.join(dir, "Contents", "Resources"), { recursive: true });
    writeFileSync(path.join(dir, "Contents", "Info.plist"), "x");
    writeFileSync(path.join(dir, "Contents", "MacOS", "launcher"), "x");
    writeFileSync(path.join(dir, "Contents", "MacOS", "bun"), "x");
    writeFileSync(path.join(dir, "Contents", "Resources", "icon.icns"), "x");

    const files = walkBundleFiles(dir).sort();
    assert.deepEqual(
      files.map((f) => path.relative(dir, f).split(path.sep).join("/")).sort(),
      [
        "Contents/Info.plist",
        "Contents/MacOS/bun",
        "Contents/MacOS/launcher",
        "Contents/Resources/icon.icns",
      ],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMachOFiles returns only files matching Mach-O magic", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mas-smoke-"));
  try {
    mkdirSync(path.join(dir, "Contents", "MacOS"), { recursive: true });
    mkdirSync(path.join(dir, "Contents", "Resources"), { recursive: true });
    writeFileSync(path.join(dir, "Contents", "Info.plist"), NOT_MACHO);
    writeFileSync(
      path.join(dir, "Contents", "MacOS", "launcher"),
      MACHO_HEADER_64,
    );
    writeFileSync(path.join(dir, "Contents", "MacOS", "bun"), MACHO_HEADER_FAT);
    writeFileSync(
      path.join(dir, "Contents", "Resources", "icon.icns"),
      NOT_MACHO,
    );

    const machos = findMachOFiles(dir)
      .map((f) => path.relative(dir, f).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(machos, ["Contents/MacOS/bun", "Contents/MacOS/launcher"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMachOFiles handles deeply nested binaries (e.g. Frameworks)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mas-smoke-"));
  try {
    const deep = path.join(
      dir,
      "Contents",
      "Frameworks",
      "Foo.framework",
      "Versions",
      "A",
    );
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "Foo"), MACHO_HEADER_64);
    writeFileSync(path.join(deep, "Info.plist"), NOT_MACHO);

    const machos = findMachOFiles(dir)
      .map((f) => path.relative(dir, f).split(path.sep).join("/"))
      .sort();
    assert.deepEqual(machos, [
      "Contents/Frameworks/Foo.framework/Versions/A/Foo",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

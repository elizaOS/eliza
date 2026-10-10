import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
const passwords = path.join(
  plugin,
  "android/src/main/java/ai/eliza/plugins/passwords",
);
const custody = path.join(
  plugin,
  "../plugin-native-secure-store/android/src/main/java/ai/eliza/plugins/securestore/nativeonly",
);
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

test("CSV export and import parsing, exact-origin binding and skip rules", (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "password-csv-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      path.join(custody, "PasswordFacets.java"),
      path.join(passwords, "PasswordCsv.java"),
      path.join(plugin, "test/native-host/PasswordCsvTest.java"),
    ],
    { timeout: 60000 },
  );
  const output = execFileSync(
    bin("java"),
    ["-cp", classes, "PasswordCsvTest"],
    { timeout: 60000, encoding: "utf8" },
  );
  assert.match(output, /^\d+ assertions passed/);
  const large = execFileSync(
    bin("java"),
    ["-Xmx32m", "-cp", classes, "PasswordCsvTest", "large-export"],
    { timeout: 60000, encoding: "utf8" },
  );
  assert.match(large, /^Bounded export passed:/);
});

test("CSV limits match the vault store", () => {
  const csv = fs.readFileSync(path.join(passwords, "PasswordCsv.java"), "utf8");
  const store = fs.readFileSync(
    path.join(custody, "PasswordVaultStore.java"),
    "utf8",
  );
  for (const [, name, value] of [
    ...csv.matchAll(/MAX_(LABEL|USERNAME|PASSWORD) = (\d+)/g),
  ])
    assert.match(store, new RegExp(`MAX_${name} = ${value}\\b`), name);
  assert.match(store, /MAX_ENTRIES = 1000\b/);
  assert.match(csv, /MAX_ROWS = 1000\b/);
});

test("transfer bridge results carry counts only and secrets never leave native code", () => {
  const source = fs.readFileSync(
    path.join(passwords, "PasswordTransferPlugin.java"),
    "utf8",
  );
  const puts = [...source.matchAll(/\b(?:done|none)\.put\("([a-z]+)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual([...new Set(puts)].sort(), [
    "exported",
    "imported",
    "skipped",
  ]);
  assert.doesNotMatch(source, /android\.util\.Log|System\.out|printStackTrace/);
  for (const [extra] of source.matchAll(/putExtra\([^;]*\)/g))
    assert.doesNotMatch(extra, /record|secret|row\.|bytes/, extra);
  assert.match(
    source,
    /access\.lock\(\);\n\s*SecretSurfaces\.dismiss\(\);\n\s*PasswordUnlock\.prompt/,
    "export requires a fresh authentication",
  );
  assert.match(
    source,
    /Intent\.ACTION_CREATE_DOCUMENT/,
    "export writes only to a user-picked document",
  );
  assert.match(
    source,
    /store\.addWebsiteEntries\(incoming\)/,
    "import uses one atomic addition with current-vault duplicate checking",
  );
  const rejects = [...source.matchAll(/call\.reject\(([^;]+)\);/g)].map(
    (m) => m[1],
  );
  for (const reject of rejects) {
    assert.doesNotMatch(reject, /row\.|record\.|secret|bytes/, reject);
    if (/getMessage\(\)/.test(reject))
      assert.match(reject, /^safeImportMessage\(/, reject);
  }
});

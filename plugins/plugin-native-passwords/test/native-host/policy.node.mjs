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
  "../plugin-native-secure-store/android-nativeonly/src/main/java/ai/eliza/plugins/securestore/nativeonly",
);
test("autofill admission, matching, generation and request capabilities", (t) => {
  const classes = fs.mkdtempSync(path.join(os.tmpdir(), "password-policy-"));
  t.after(() => fs.rmSync(classes, { recursive: true, force: true }));
  const bin = (name) =>
    process.env.JAVA_HOME
      ? path.join(process.env.JAVA_HOME, "bin", name)
      : name;
  execFileSync(
    bin("javac"),
    [
      "-d",
      classes,
      path.join(custody, "PasswordFacets.java"),
      ...[
        "PasswordEditorPolicy",
        "PasswordFormPolicy",
        "PasswordMatching",
        "PasswordGenerator",
        "PasswordRequests",
      ].map((name) => path.join(passwords, `${name}.java`)),
      path.join(plugin, "test/native-host/PasswordPolicyTest.java"),
    ],
    { timeout: 60000 },
  );
  const output = execFileSync(
    bin("java"),
    ["-cp", classes, "PasswordPolicyTest"],
    {
      timeout: 60000,
      encoding: "utf8",
    },
  );
  assert.match(output, /^\d+ assertions passed/);
});

test("page script has no path to the host-native vault controls", () => {
  const bridge = (name) =>
    [
      ...fs
        .readFileSync(path.join(passwords, `${name}.java`), "utf8")
        .matchAll(/@PluginMethod public void (\w+)/g),
    ].map((match) => match[1]);
  assert.deepEqual(bridge("PasswordsPlugin").sort(), [
    "copy",
    "list",
    "lock",
    "openAutofillSettings",
    "openEditor",
    "remove",
    "reset",
    "reveal",
    "save",
    "status",
    "unlock",
  ]);
  for (const file of [
    path.join(passwords, "PasswordsPlugin.java"),
    path.join(
      plugin,
      "android-transfer/src/main/java/ai/eliza/plugins/passwords/PasswordTransferPlugin.java",
    ),
  ])
    assert.doesNotMatch(
      fs.readFileSync(file, "utf8"),
      /destroy(Vault)?\(|lockAndClose|setAdmission/,
    );
  assert.doesNotMatch(
    fs.readFileSync(path.join(plugin, "src/definitions.ts"), "utf8"),
    /destroy/i,
  );
});

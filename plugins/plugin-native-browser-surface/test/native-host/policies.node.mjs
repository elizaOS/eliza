import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const plugin = fileURLToPath(new URL("../..", import.meta.url));
const source = path.join(
  plugin,
  "android/src/main/java/ai/eliza/plugins/browsersurface",
);
const classes = [
  "BrowserWebOrigin",
  "BrowserDownloadPolicy",
  "BrowserSitePermissions",
  "BrowserSessionPolicy",
  "BrowserExternalLinkPolicy",
  "BrowserAutofillEligibility",
  "BrowserPageHandoffs",
  "BrowserMainFrameGate",
  "BrowserProfilePolicy",
  "BrowserCapturePolicy",
  "BrowserFieldOrigin",
  "BrowserHttpAuthOrigin",
];
const consumers = [
  "BrowserWebPolicyTest",
  "BrowserSessionPolicyTest",
  "BrowserLinkAutofillPolicyTest",
  "BrowserPageHandoffsTest",
  "BrowserMainFrameGateTest",
  "BrowserProfileCaptureTest",
];
const bin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;

test("JVM browser policies preserve origin, profile and persisted record boundaries", async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "browser-policies-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-J-Xmx128m",
      "-d",
      output,
      ...classes.map((name) => path.join(source, `${name}.java`)),
      ...consumers.map((name) =>
        path.join(plugin, "test/native-host", `${name}.java`),
      ),
    ],
    { timeout: 60000 },
  );
  for (const consumer of consumers)
    await t.test(consumer, () => {
      const result = execFileSync(
        bin("java"),
        ["-Xmx128m", "-cp", output, consumer],
        { timeout: 60000, encoding: "utf8" },
      );
      assert.match(result, /^\d+ assertions passed/);
      t.diagnostic(`${consumer}: ${result.trim()}`);
    });
});

// The login-field and HTTP-auth bindings against the password provider's own admission policy.
const passwords = fileURLToPath(
  new URL("../../../plugin-native-passwords", import.meta.url),
);
const secureStore = fileURLToPath(
  new URL("../../../plugin-native-secure-store", import.meta.url),
);
const autofillConsumers = [
  "BrowserFieldOriginTest",
  "BrowserHttpAuthOriginTest",
];

test("browser login bindings are admitted by the password policy only for the bound origin", async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "browser-autofill-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  execFileSync(
    bin("javac"),
    [
      "-J-Xmx128m",
      "-d",
      output,
      ...[
        "BrowserWebOrigin",
        "BrowserAutofillEligibility",
        "BrowserFieldOrigin",
        "BrowserHttpAuthOrigin",
      ].map((name) => path.join(source, `${name}.java`)),
      path.join(
        passwords,
        "android/src/main/java/ai/eliza/plugins/passwords/PasswordFormPolicy.java",
      ),
      path.join(
        secureStore,
        "android/src/main/java/ai/eliza/plugins/securestore/nativeonly/PasswordFacets.java",
      ),
      ...autofillConsumers.map((name) =>
        path.join(plugin, "test/native-host", `${name}.java`),
      ),
    ],
    { timeout: 60000 },
  );
  for (const consumer of autofillConsumers)
    await t.test(consumer, () => {
      const result = execFileSync(
        bin("java"),
        ["-Xmx128m", "-cp", output, consumer],
        {
          timeout: 60000,
          encoding: "utf8",
        },
      );
      assert.match(result, /^\d+ assertions passed/);
      t.diagnostic(`${consumer}: ${result.trim()}`);
    });
});

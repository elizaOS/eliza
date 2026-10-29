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
  "BrowserPageReading",
  "BrowserSitePrompt",
  "BrowserExternalPage",
  "BrowserAutofillExtras",
  "BrowserTabHostConfig",
];
const consumers = [
  "BrowserWebPolicyTest",
  "BrowserSessionPolicyTest",
  "BrowserLinkAutofillPolicyTest",
  "BrowserPageHandoffsTest",
  "BrowserMainFrameGateTest",
  "BrowserProfileCaptureTest",
  "BrowserSitePromptTest",
  "BrowserTabHostConfigTest",
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

// The native and renderer halves of page reading refuse the same HTTPS addresses and say the same words.
test("native and renderer page reading agree", async (t) => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "browser-reading-"));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const urls = [
    "https://example.com/garden/journal",
    "https://pass.proton.me/",
    "https://a.vault.bitwarden.com/x",
    "https://example.com/%70assword",
    "https://example.com/#/vault",
    "https://example.com/article?API+KEY=x",
    "https://example.com/a?%61pi%5fkey=x",
    "https://example.com/account/settings",
    "https://example.com/tokens-of-appreciation",
    "https://user@example.com/",
    "https://example.com/%zz",
    "https://example.com./reset-password",
  ];
  const probe = path.join(output, "ReadingProbe.java");
  fs.writeFileSync(
    probe,
    `public final class ReadingProbe { public static void main(String[] urls) { System.out.println(ai.eliza.plugins.browsersurface.BrowserPageReading.UNSUPPORTED_MESSAGE); for (String url : urls) System.out.println(ai.eliza.plugins.browsersurface.BrowserPageReading.sensitiveUrl(url)); } }`,
  );
  execFileSync(
    bin("javac"),
    [
      "-J-Xmx128m",
      "-d",
      output,
      path.join(source, "BrowserPageReading.java"),
      probe,
    ],
    { timeout: 60000 },
  );
  const [message, ...native] = execFileSync(
    bin("java"),
    ["-Xmx128m", "-cp", output, "ReadingProbe", ...urls],
    { timeout: 60000, encoding: "utf8" },
  )
    .trim()
    .split("\n");
  const renderer = await import(
    new URL("../../src/page-reading.ts", import.meta.url).href
  );
  assert.equal(message, renderer.READING_UNSUPPORTED_MESSAGE);
  assert.deepEqual(
    native.map((value) => value === "true"),
    urls.map((url) => renderer.sensitiveReadingUrl(url)),
  );
});

// The sealed site-permission record needs org.json, which Android provides. ELIZA_ORG_JSON_JAR
// names the jar; otherwise the Gradle cache copy is used when present.
const jsonCache = path.join(
  os.homedir(),
  ".gradle/caches/modules-2/files-2.1/org.json/json",
);
function cachedJsonJar() {
  if (!fs.existsSync(jsonCache)) return undefined;
  for (const version of fs.readdirSync(jsonCache).sort().reverse())
    for (const hash of fs.readdirSync(path.join(jsonCache, version))) {
      const jar = path.join(jsonCache, version, hash, `json-${version}.jar`);
      if (fs.existsSync(jar)) return jar;
    }
  return undefined;
}
const jsonJar = process.env.ELIZA_ORG_JSON_JAR || cachedJsonJar();

test("sealed site-permission records keep order, the bound and the stored format", {
  skip: jsonJar ? false : "org.json jar unavailable (set ELIZA_ORG_JSON_JAR)",
}, () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "browser-record-"));
  try {
    execFileSync(
      bin("javac"),
      [
        "-J-Xmx128m",
        "-cp",
        jsonJar,
        "-d",
        output,
        ...[
          "BrowserWebOrigin",
          "BrowserSitePermissions",
          "BrowserSitePermissionRecord",
        ].map((name) => path.join(source, `${name}.java`)),
        path.join(
          plugin,
          "test/native-host/BrowserSitePermissionRecordTest.java",
        ),
      ],
      { timeout: 60000 },
    );
    const result = execFileSync(
      bin("java"),
      [
        "-Xmx128m",
        "-cp",
        `${output}${path.delimiter}${jsonJar}`,
        "BrowserSitePermissionRecordTest",
      ],
      { timeout: 60000, encoding: "utf8" },
    );
    assert.match(result, /^\d+ assertions passed/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

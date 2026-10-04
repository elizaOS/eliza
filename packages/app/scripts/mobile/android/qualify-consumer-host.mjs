/** SDK qualification: build two independent identities in owned temporary hosts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../../scripts/lib/test-output.ts";
import { resolveAndroidSdkRoot, resolveJavaHome } from "../toolchain.ts";
import { generateAndroidConsumerHost } from "./consumer-host.mjs";
import { createConsumerFixture } from "./consumer-host-fixture.mjs";

const upstreamRoot = path.resolve(
  fileURLToPath(new URL("../../../../..", import.meta.url)),
);
const sdk = resolveAndroidSdkRoot(process.env),
  java = resolveJavaHome();
if (!sdk || !java)
  throw new Error("Set Android SDK and JDK 21 for consumer host qualification");
const directory = testOutputPath(
  "android-consumer-host",
  new Date().toISOString().replace(/[:.]/g, "-"),
);
fs.mkdirSync(directory, { recursive: true });
const temporary = fs.mkdtempSync(
  path.join(os.tmpdir(), "android-host-qualification-"),
);
const receipts = [];
try {
  for (const brand of ["first", "second"]) {
    const consumerRoot = path.join(temporary, brand),
      output = path.join(consumerRoot, "android");
    const fixture = createConsumerFixture(
      consumerRoot,
      `example.consumer.${brand}`,
    );
    generateAndroidConsumerHost({
      consumerRoot,
      upstreamRoot,
      output,
      ...fixture,
    });
    const log = fs.openSync(path.join(directory, `${brand}.log`), "w");
    try {
      execFileSync(
        path.join(output, "gradlew"),
        [
          "--no-daemon",
          ":app:assembleStandaloneDebug",
          ":app:assembleLauncherDebug",
          ":app:assembleStandaloneRelease",
          ":app:assembleLauncherRelease",
          ":app:lint",
        ],
        {
          cwd: output,
          env: {
            ...process.env,
            JAVA_HOME: java,
            ANDROID_HOME: sdk,
            ANDROID_SDK_ROOT: sdk,
          },
          stdio: ["ignore", log, log],
        },
      );
    } finally {
      fs.closeSync(log);
    }
    for (const variant of ["standalone", "launcher"])
      for (const build of ["debug", "release"]) {
        const name = `app-${variant}-${build}${build === "release" ? "-unsigned" : ""}.apk`;
        const apk = path.join(
          output,
          "app/build/outputs/apk",
          variant,
          build,
          name,
        );
        const aapt = path.join(sdk, "build-tools/36.0.0/aapt");
        const badging = execFileSync(aapt, ["dump", "badging", apk], {
          encoding: "utf8",
        });
        const manifest = execFileSync(
          aapt,
          ["dump", "xmltree", apk, "AndroidManifest.xml"],
          { encoding: "utf8" },
        );
        assert.equal(
          /package: name='([^']+)'/.exec(badging)?.[1],
          fixture.identity.appId,
        );
        assert.equal(
          manifest.includes("android.intent.category.HOME"),
          variant === "launcher",
        );
        assert.ok(manifest.includes("android.intent.category.LAUNCHER"));
        assert.ok(!manifest.includes("ai.elizaos.app"));
        const bytes = fs.readFileSync(apk),
          artifact = `${brand}-${name}`;
        fs.writeFileSync(path.join(directory, artifact), bytes);
        receipts.push({
          appId: fixture.identity.appId,
          variant,
          build,
          artifact,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
  }
  fs.writeFileSync(
    path.join(directory, "verification.json"),
    `${JSON.stringify({ scope: "Two independent generated hosts; real debug/release APK identity and HOME manifest checks. No installation, native runtime, AOSP or user acceptance.", receipts }, null, 2)}\n`,
  );
  console.log(`Qualified ${receipts.length} APKs: ${directory}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

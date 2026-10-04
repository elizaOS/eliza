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
console.log(`Evidence: ${directory}`);
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
    fixture.identity.appName =
      brand === "first" ? '@Independent\'s "One"' : "?Deux & Café %s %s";
    let runtimeDirectory;
    if (brand === "second") {
      runtimeDirectory = path.join(consumerRoot, "packaging-fixture");
      const main = path.join(runtimeDirectory, "android/app/src/main");
      for (const abi of ["arm64-v8a", "x86_64", "riscv64"]) {
        const directory = path.join(main, "assets/agent", abi);
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(
          path.join(directory, "excluded.bin"),
          "must not enter APK assets",
        );
      }
      fs.mkdirSync(path.join(main, "jniLibs"), { recursive: true });
      fs.writeFileSync(
        path.join(main, "assets/agent/agent-bundle.js"),
        "// packaging fixture only; not an executable runtime\n",
      );
      fs.writeFileSync(
        path.join(main, "assets/agent-runtime.inventory"),
        "packaging qualification only\n",
      );
    }
    generateAndroidConsumerHost({
      consumerRoot,
      upstreamRoot,
      output,
      ...fixture,
      runtimeDirectory,
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
          ":companion:assembleDebug",
          ":companion:assembleRelease",
          ":companion:lint",
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
    const aapt = path.join(sdk, "build-tools/36.0.0/aapt");
    for (const build of ["debug", "release"]) {
      const name = `companion-${build}${build === "release" ? "-unsigned" : ""}.apk`;
      const apk = path.join(
        consumerRoot,
        "companion/build/outputs/apk",
        build,
        name,
      );
      const bytes = fs.readFileSync(apk),
        artifact = `${brand}-${name}`;
      fs.writeFileSync(path.join(directory, artifact), bytes);
      const badging = execFileSync(aapt, ["dump", "badging", apk], {
        encoding: "utf8",
      });
      assert.equal(
        /package: name='([^']+)'/.exec(badging)?.[1],
        `${fixture.identity.appId}.companion`,
      );
      assert.ok(
        execFileSync(aapt, ["list", apk], { encoding: "utf8" })
          .split("\n")
          .includes("assets/companion-only.txt"),
      );
      receipts.push({
        appId: `${fixture.identity.appId}.companion`,
        independentModule: true,
        build,
        artifact,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
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
        assert.equal(
          execFileSync(aapt, ["list", apk], { encoding: "utf8" })
            .split("\n")
            .includes("assets/companion-only.txt"),
          false,
        );
        const bytes = fs.readFileSync(apk),
          artifact = `${brand}-${name}`;
        fs.writeFileSync(path.join(directory, artifact), bytes);
        const badging = execFileSync(aapt, ["dump", "badging", apk], {
          encoding: "utf8",
        });
        // AAPT badging escapes embedded double quotes in its displayed label.
        assert.equal(
          /^application-label:'(.*)'$/m.exec(badging)?.[1],
          fixture.identity.appName.replaceAll('"', '\\"'),
        );
        assert.equal(
          /^launchable-activity: name='example\.host\.MainActivity'\s+label='([^']*)'/m.exec(
            badging,
          )?.[1],
          variant,
        );
        if (runtimeDirectory) {
          const entries = execFileSync("unzip", ["-Z1", apk], {
            encoding: "utf8",
          }).split("\n");
          assert.ok(entries.includes("assets/agent/agent-bundle.js"));
          assert.ok(entries.includes("assets/agent-runtime.inventory"));
          for (const abi of ["arm64-v8a", "x86_64", "riscv64"]) {
            assert.equal(
              entries.some((entry) => entry.startsWith(`assets/agent/${abi}/`)),
              false,
            );
          }
        }
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
        receipts.push({
          appId: fixture.identity.appId,
          appName: fixture.identity.appName,
          runtimePackagingFixture: Boolean(runtimeDirectory),
          variant,
          build,
          artifact,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
  }
  fs.writeFileSync(
    path.join(directory, "verification.json"),
    `${JSON.stringify({ scope: "Two independent generated hosts with linked libraries and separate companion APK modules; real debug/release APK identity, companion asset isolation and HOME manifest checks. The second host configures synthetic runtime assets and verifies ABI-asset exclusion; no executable runtime is supplied. No installation, native runtime, AOSP or user acceptance.", receipts }, null, 2)}\n`,
  );
  console.log(`Qualified ${receipts.length} APKs: ${directory}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

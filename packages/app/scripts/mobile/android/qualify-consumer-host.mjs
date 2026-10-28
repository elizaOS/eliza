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
/**
 * The first identity also exercises the product-host profile: an in-place output beside an
 * authored file, release signing from a synthetic key named by environment variables,
 * debug-only test sources, an admission task feeding a generated source directory, a staged
 * asset, a consumer product script and generation inputs. The key is created here and never
 * leaves the temporary host.
 */
function configureProductHost(consumerRoot, output, fixture, javaHome) {
  const source = (relative) => ({ root: "consumer", path: relative });
  const write = (relative, text) => {
    const file = path.join(consumerRoot, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  };
  write("android/AUTHORED.md", "authored host file\n");
  // A Java-only host uses package directories: lint resolves manifest classes by path.
  fs.mkdirSync(path.join(consumerRoot, "src/example/host"), {
    recursive: true,
  });
  fs.renameSync(
    path.join(consumerRoot, "src/MainActivity.java"),
    path.join(consumerRoot, "src/example/host/MainActivity.java"),
  );
  write(
    "mocks/java/example/qualification/MockOnly.java",
    "package example.qualification; public final class MockOnly {}\n",
  );
  write("rules.pro", "-dontwarn example.**\n");
  write("fixture-receipt.json", '{"fixture":true}\n');
  write(
    "product.gradle",
    "def marker = layout.buildDirectory.file('fixture/product-script.txt')\ndef productMarker = tasks.register('fixtureProductMarker') { outputs.file(marker); doLast { marker.get().asFile.text = 'applied' } }\ntasks.named('preBuild').configure { dependsOn productMarker }\n",
  );
  const keystore = path.join(consumerRoot, "synthetic-release.p12");
  execFileSync(
    path.join(javaHome, "bin/keytool"),
    [
      "-genkeypair",
      "-keystore",
      keystore,
      "-storetype",
      "PKCS12",
      "-storepass",
      "synthetic-fixture",
      "-keypass",
      "synthetic-fixture",
      "-alias",
      "fixture",
      "-keyalg",
      "RSA",
      "-keysize",
      "2048",
      "-validity",
      "2",
      "-dname",
      "CN=Synthetic consumer host qualification only",
    ],
    { stdio: "pipe" },
  );
  Object.assign(fixture.profile, {
    releaseMinify: true,
    kotlin: false,
    preserveRuntimeBytes: true,
    buildTypes: {
      release: { shrinkResources: true, proguardFiles: [source("rules.pro")] },
    },
    signing: {
      storeFile: "FIXTURE_STORE",
      storePassword: "FIXTURE_STORE_PASSWORD",
      keyAlias: "FIXTURE_KEY_ALIAS",
      keyPassword: "FIXTURE_KEY_PASSWORD",
    },
    testMocks: {
      property: "FIXTURE_TEST_MOCKS",
      buildConfigField: "FIXTURE_TEST_MOCKS",
      debug: { java: [source("mocks/java")] },
    },
    admission: [
      {
        name: "writeFixtureSource",
        command: [
          process.execPath,
          "-e",
          "const fs=require('node:fs'),path=require('node:path');fs.mkdirSync(path.dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],'package example.qualification; public final class Generated {}\\n')",
          path.join(
            output,
            "app/build/generated/fixture/java/example/qualification/Generated.java",
          ),
        ],
        directory: source("src"),
      },
    ],
    generatedSources: [
      { sourceSet: "main", kind: "java", path: "generated/fixture/java" },
    ],
    assetFiles: [
      { source: source("fixture-receipt.json"), name: "fixture-receipt.json" },
    ],
    appScripts: [source("product.gradle")],
    generationInputs: [source("main.xml")],
  });
  return {
    FIXTURE_STORE: keystore,
    FIXTURE_STORE_PASSWORD: "synthetic-fixture",
    FIXTURE_KEY_ALIAS: "fixture",
    FIXTURE_KEY_PASSWORD: "synthetic-fixture",
    FIXTURE_TEST_MOCKS: "1",
  };
}
const dexClasses = (apk) =>
  execFileSync("unzip", ["-Z1", apk], { encoding: "utf8" })
    .split("\n")
    .filter((entry) => /^classes\d*\.dex$/.test(entry))
    .map((entry) =>
      execFileSync("unzip", ["-p", apk, entry], {
        maxBuffer: 256 * 1024 * 1024,
      }).toString("latin1"),
    )
    .join("\n");
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
    const productEnvironment =
      brand === "first"
        ? configureProductHost(consumerRoot, output, fixture, java)
        : null;
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
      inPlace: Boolean(productEnvironment),
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
            ...productEnvironment,
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
    if (productEnvironment) {
      assert.equal(
        fs.readFileSync(path.join(output, "AUTHORED.md"), "utf8"),
        "authored host file\n",
      );
      assert.equal(
        fs.readFileSync(
          path.join(output, "app/build/fixture/product-script.txt"),
          "utf8",
        ),
        "applied",
      );
    }
    const apksigner = path.join(sdk, "build-tools/36.0.0/apksigner");
    for (const variant of ["standalone", "launcher"])
      for (const build of ["debug", "release"]) {
        const signedRelease =
          Boolean(productEnvironment) && build === "release";
        const name = `app-${variant}-${build}${build === "release" && !signedRelease ? "-unsigned" : ""}.apk`;
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
        const entries = execFileSync(aapt, ["list", apk], {
          encoding: "utf8",
        }).split("\n");
        assert.ok(entries.includes(`assets/${build}-only.txt`));
        if (productEnvironment) {
          assert.ok(entries.includes("assets/fixture-receipt.json"));
          const classes = dexClasses(apk);
          // Test sources and the admission-generated class reach debug variants only.
          assert.equal(
            classes.includes("Lexample/qualification/MockOnly;"),
            build === "debug",
          );
          if (build === "debug")
            assert.ok(classes.includes("Lexample/qualification/Generated;"));
          if (signedRelease)
            assert.match(
              execFileSync(apksigner, ["verify", "--print-certs", apk], {
                encoding: "utf8",
              }),
              /CN=Synthetic consumer host qualification only/,
            );
        }
        assert.equal(
          entries.includes(
            `assets/${build === "debug" ? "release" : "debug"}-only.txt`,
          ),
          false,
        );
        const resources = execFileSync(
          path.join(sdk, "build-tools/36.0.0/aapt2"),
          ["dump", "resources", apk],
          { encoding: "utf8" },
        );
        const policyPath =
          /xml\/consumer_network_security\n[^\n]*\(file\) (\S+)/.exec(
            resources,
          )?.[1];
        assert.ok(
          policyPath,
          "Network policy must be present in the APK resource table",
        );
        const networkPolicy = execFileSync(
          aapt,
          ["dump", "xmltree", apk, policyPath],
          { encoding: "utf8" },
        );
        assert.equal(networkPolicy.includes('"user"'), build === "debug");
        assert.equal(networkPolicy.includes('"localhost"'), build === "debug");
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
          productHostProfile: Boolean(productEnvironment),
          signedRelease,
          buildTypeIsolation: true,
          variant,
          build,
          artifact,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
  }
  fs.writeFileSync(
    path.join(directory, "verification.json"),
    `${JSON.stringify({ scope: "Two independent generated hosts with linked libraries and separate companion APK modules; real debug/release APK identity, build-type asset and TLS-resource isolation, companion asset isolation and HOME manifest checks. The first host is generated in place beside an authored file and checks release signing with a synthetic key named by environment variables, debug-only test sources, an admission-generated source, a staged asset and a product script. The second host configures synthetic runtime assets and verifies ABI-asset exclusion; no executable runtime is supplied. No installation, native runtime, AOSP or user acceptance.", receipts }, null, 2)}\n`,
  );
  console.log(`Qualified ${receipts.length} APKs: ${directory}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

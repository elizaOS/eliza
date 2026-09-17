/** Exercises the real iOS overlay against isolated platform trees so CocoaPods owns the encoder on every target without removing unrelated SPM dependencies. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const overlayUrl = new URL("./overlay.mjs", import.meta.url).href;
const policyUrl = new URL("./policy.mjs", import.meta.url).href;
const manifest = `// swift-tools-version: 5.9
import PackageDescription
let package = Package(name: "CapApp-SPM", dependencies: [
    .package(name: "UnrelatedPlugin", path: "../unrelated"),
    .package(name: "LlamaCppCapacitor", path: "../llama")
], targets: [.target(name: "CapApp", dependencies: [
    .product(name: "UnrelatedPlugin", package: "UnrelatedPlugin"),
    .product(name: "LlamaCppCapacitor", package: "LlamaCppCapacitor")
])])
`;
for (const [name, sdk, included, store] of [
  ["local device", "iphoneos", true, false],
  ["local simulator", "iphonesimulator", true, false],
  ["cloud device", "iphoneos", false, false],
  ["App Store device", "iphoneos", true, true],
]) {
  test(`${name} retains unrelated SPM dependencies and uses canonical encoder ownership`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-ios-overlay-"));
    try {
      const app = path.join(root, "packages/app");
      const packagePath = path.join(app, "ios/App/CapApp-SPM/Package.swift");
      fs.mkdirSync(path.dirname(packagePath), { recursive: true });
      fs.mkdirSync(path.join(app, "ios/App/App"), { recursive: true });
      fs.mkdirSync(path.join(root, "packages/app-core/platforms/ios"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(app, "package.json"),
        '{"name":"overlay-fixture"}',
      );
      fs.writeFileSync(
        path.join(app, "app.config.ts"),
        'export default { appId: "ai.elizaos.overlayfixture", appName: "Overlay Fixture" };',
      );
      for (const packageName of ["@capacitor/ios", "llama-cpp-capacitor"]) {
        const packageRoot = path.join(root, "node_modules", packageName);
        fs.mkdirSync(packageRoot, { recursive: true });
        fs.writeFileSync(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: packageName, version: "0.0.0-fixture" }),
        );
      }
      fs.writeFileSync(packagePath, manifest);
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import assert from 'node:assert/strict';
        import { prepareIosOverlay } from ${JSON.stringify(overlayUrl)};
        import { shouldIncludeIosLlama, shouldUseIosFusedLocalInference } from ${JSON.stringify(policyUrl)};
        prepareIosOverlay({ buildTarget: { sdk: ${JSON.stringify(sdk)} } });
        assert.equal(shouldIncludeIosLlama(), ${included && !store});
        assert.equal(shouldUseIosFusedLocalInference(), ${included && !store});
      `,
        ],
        {
          cwd: root,
          env: {
            ...process.env,
            ELIZA_MOBILE_REPO_ROOT: root,
            ELIZA_IOS_INCLUDE_LLAMA: included ? "1" : "0",
            ELIZA_RELEASE_AUTHORITY: store ? "apple-app-store" : "",
            ELIZA_BUILD_VARIANT: "",
            ELIZA_IOS_FULL_BUN_ENGINE: "0",
            ELIZA_IOS_APP_STORE_LOCAL_RUNTIME: "0",
            ELIZA_IOS_RUNTIME_MODE: "cloud",
            ELIZA_IOS_HEALTHKIT_ENABLED: "0",
          },
          stdio: "pipe",
        },
      );
      const actual = fs.readFileSync(packagePath, "utf8");
      assert.equal(actual.includes("LlamaCppCapacitor"), false);
      const podfile = fs.readFileSync(
        path.join(app, "ios/App/Podfile"),
        "utf8",
      );
      assert.equal(
        podfile.includes("pod 'LlamaCppCapacitor'"),
        included && !store,
      );
      assert.ok(podfile.includes("pod 'Capacitor'"));
      for (const line of manifest
        .split("\n")
        .filter((line) => line.includes("UnrelatedPlugin"))) {
        assert.ok(
          actual.includes(line.replace(/,$/, "")),
          `Unrelated dependency changed: ${line}`,
        );
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

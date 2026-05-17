import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkMobileArtifacts } from "./check-mobile-artifacts.mjs";

const tempRoots: string[] = [];

const requiredPods = [
  "Capacitor",
  "CapacitorCordova",
  "CapacitorApp",
  "CapacitorPreferences",
  "CapacitorKeyboard",
  "CapacitorBrowser",
  "ElizaosCapacitorAgent",
  "ElizaosCapacitorGateway",
  "ElizaosCapacitorMobileSignals",
  "ElizaosCapacitorWebsiteblocker",
];

async function writeFile(root: string, relativePath: string, content: string) {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

function podfile(pods = requiredPods) {
  return `platform :ios, '15.0'
use_frameworks!

def capacitor_pods
${pods.map((pod) => `  pod '${pod}', :path => '../${pod}'`).join("\n")}
end
`;
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key><string>$(ELIZA_DISPLAY_NAME)</string>
  <key>CFBundleIdentifier</key><string>$(PRODUCT_BUNDLE_IDENTIFIER)</string>
  <key>CFBundleName</key><string>$(PRODUCT_NAME)</string>
  <key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string>
  <key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>
  <key>LSRequiresIPhoneOS</key><true/>
  <key>NSCameraUsageDescription</key><string>Camera</string>
  <key>NSLocalNetworkUsageDescription</key><string>Network</string>
  <key>NSLocationWhenInUseUsageDescription</key><string>Location</string>
  <key>NSMicrophoneUsageDescription</key><string>Mic</string>
</dict>
</plist>
`;
}

function entitlements() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array><string>group.ai.elizaos.app</string></array>
</dict>
</plist>
`;
}

function androidManifest(
  permissions = [
    "android.permission.INTERNET",
    "android.permission.RECORD_AUDIO",
    "android.permission.CAMERA",
    "android.permission.ACCESS_FINE_LOCATION",
    "android.permission.FOREGROUND_SERVICE",
    "android.permission.POST_NOTIFICATIONS",
  ],
) {
  return `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="@string/app_name">
    <activity android:name=".MainActivity" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
    <service android:name=".GatewayConnectionService" android:exported="false" />
    <service android:name=".ElizaAgentService" android:exported="false" />
  </application>
${permissions.map((permission) => `  <uses-permission android:name="${permission}" />`).join("\n")}
</manifest>
`;
}

async function makeRepo() {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mobile-gate-"));
  tempRoots.push(repoRoot);

  await writeFile(
    repoRoot,
    "package.json",
    JSON.stringify({
      scripts: {
        "build:android:system":
          "node packages/app-core/scripts/run-mobile-build.mjs android-system",
      },
    }),
  );
  await writeFile(
    repoRoot,
    "packages/app/package.json",
    JSON.stringify({
      scripts: {
        "build:android:system":
          "node ../../packages/app-core/scripts/run-mobile-build.mjs android-system",
      },
    }),
  );
  await writeFile(
    repoRoot,
    "packages/app/app.config.ts",
    `const config = { appName: "elizaOS", appId: "ai.elizaos.app" }; export default config;`,
  );
  await writeFile(
    repoRoot,
    "packages/app/capacitor.config.ts",
    `import appConfig from "./app.config"; export default { appId: appConfig.appId, appName: appConfig.appName };`,
  );

  for (const file of [
    "packages/app/ios/App/Podfile",
    "packages/app-core/platforms/ios/App/Podfile",
  ]) {
    await writeFile(repoRoot, file, podfile());
  }
  for (const file of [
    "packages/app/ios/App/App/Info.plist",
    "packages/app-core/platforms/ios/App/App/Info.plist",
  ]) {
    await writeFile(repoRoot, file, infoPlist());
  }
  for (const file of [
    "packages/app/ios/App/App/App.entitlements",
    "packages/app-core/platforms/ios/App/App/App.entitlements",
  ]) {
    await writeFile(repoRoot, file, entitlements());
  }

  await writeFile(
    repoRoot,
    "packages/app/android/app/build.gradle",
    `android { namespace "ai.elizaos.app" defaultConfig { applicationId "ai.elizaos.app" } }`,
  );
  await writeFile(
    repoRoot,
    "packages/app/android/app/src/main/AndroidManifest.xml",
    androidManifest(),
  );
  await writeFile(
    repoRoot,
    "packages/app/android/app/src/main/assets/capacitor.config.json",
    JSON.stringify({ appId: "ai.elizaos.app", appName: "elizaOS" }),
  );
  await writeFile(
    repoRoot,
    "packages/app/android/app/src/main/assets/capacitor.plugins.json",
    JSON.stringify([
      { pkg: "@capacitor/app" },
      { pkg: "@capacitor/keyboard" },
      { pkg: "@capacitor/preferences" },
      { pkg: "@elizaos/capacitor-agent" },
      { pkg: "@elizaos/capacitor-gateway" },
      { pkg: "@elizaos/capacitor-mobile-signals" },
      { pkg: "@elizaos/capacitor-system" },
      { pkg: "@elizaos/capacitor-websiteblocker" },
    ]),
  );
  for (const file of [
    "packages/app/android/app/src/main/assets/public/index.html",
    "packages/app/android/app/src/main/assets/agent/agent-bundle.js",
    "packages/app/android/app/src/main/assets/agent/launch.sh",
    "packages/app/android/app/src/main/assets/agent/arm64-v8a/bun",
    "packages/app/android/app/src/main/assets/agent/x86_64/bun",
  ]) {
    await writeFile(repoRoot, file, "fixture");
  }

  return repoRoot;
}

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("mobile artifacts gate", () => {
  it("passes a complete static mobile artifact fixture without native builds", async () => {
    const repoRoot = await makeRepo();

    const result = checkMobileArtifacts({ repoRoot });

    expect(result.ok).toBe(true);
    expect(result.summary.nativeBuildsRun).toBe(false);
  });

  it("fails when required iOS pods are missing", async () => {
    const repoRoot = await makeRepo();
    await writeFile(
      repoRoot,
      "packages/app/ios/App/Podfile",
      podfile(requiredPods.filter((pod) => pod !== "CapacitorPreferences")),
    );

    const result = checkMobileArtifacts({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "missing-ios-pod",
        file: "packages/app/ios/App/Podfile",
        missing: expect.arrayContaining(["CapacitorPreferences"]),
      }),
    );
  });

  it("fails when build:android:system scripts are missing", async () => {
    const repoRoot = await makeRepo();
    await writeFile(
      repoRoot,
      "packages/app/package.json",
      JSON.stringify({ scripts: {} }),
    );

    const result = checkMobileArtifacts({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "missing-script",
        file: "packages/app/package.json",
        script: "build:android:system",
      }),
    );
  });

  it("fails when Android manifests are missing", async () => {
    const repoRoot = await makeRepo();
    await fs.rm(
      path.join(
        repoRoot,
        "packages/app/android/app/src/main/AndroidManifest.xml",
      ),
    );

    const result = checkMobileArtifacts({ repoRoot });

    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({
        type: "missing-file",
        file: "packages/app/android/app/src/main/AndroidManifest.xml",
      }),
    );
  });
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const output = path.resolve(process.argv[2]);
const fixture = fs.mkdtempSync(
  path.join(os.tmpdir(), "eliza-receipt-overlay-"),
);
const app = path.join(fixture, "packages/app");
const android = path.join(app, "android");
const assets = path.join(android, "app/src/main/assets");
const appId = "ai.receipt.fixture";

try {
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(app, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(app, "app.config.ts"),
    `export default { appId: "${appId}", appName: "Receipt fixture" };`,
  );
  fs.writeFileSync(
    path.join(android, "capacitor.settings.gradle"),
    "include ':capacitor-app'\n",
  );
  fs.writeFileSync(
    path.join(assets, "capacitor.plugins.json"),
    JSON.stringify([
      {
        pkg: "@capacitor/app",
        classpath: "com.capacitorjs.plugins.app.AppPlugin",
      },
    ]),
  );
  process.env.ELIZA_MOBILE_REPO_ROOT = fixture;
  process.env.ELIZA_ANDROID_USE_APP_DIR = "1";
  process.env.ELIZA_APP_ID = appId;
  const { androidDir } = await import("../../mobile/context.ts");
  assert.equal(androidDir, android);
  const { overlayAndroid } = await import("../../mobile/android/overlay.ts");
  const { reconcilePluginManifestWithGradle } = await import(
    "../../mobile/android/gradle-reconciliation.ts"
  );
  overlayAndroid();
  reconcilePluginManifestWithGradle(assets);

  const generatedJava = path.join(
    android,
    "app/src/main/java/ai/receipt/fixture",
  );
  for (const name of [
    "MainActivity.java",
    "DeepLinkBufferPlugin.java",
    "ReceiptAppPlugin.java",
  ]) {
    const source = fs.readFileSync(path.join(generatedJava, name), "utf8");
    assert.match(source, /^package ai\.receipt\.fixture;/m);
  }
  fs.mkdirSync(path.join(output, "java/ai/receipt/fixture"), {
    recursive: true,
  });
  for (const name of ["DeepLinkBufferPlugin.java", "ReceiptAppPlugin.java"]) {
    fs.copyFileSync(
      path.join(generatedJava, name),
      path.join(output, "java/ai/receipt/fixture", name),
    );
  }
  fs.mkdirSync(path.join(output, "assets"), { recursive: true });
  fs.copyFileSync(
    path.join(assets, "capacitor.plugins.json"),
    path.join(output, "assets/receipt-custom.plugins.json"),
  );
} finally {
  fs.rmSync(fixture, { recursive: true, force: true });
}

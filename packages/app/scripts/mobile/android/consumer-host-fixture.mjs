/** Minimal independent host used only for generated-project qualification. */
import fs from "node:fs";
import path from "node:path";
export function createConsumerFixture(root, appId) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src/MainActivity.java"),
    "package example.host; public final class MainActivity extends example.library.BaseActivity {}\n",
  );
  fs.writeFileSync(
    path.join(root, "main.xml"),
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="@string/app_name"><activity android:name="example.host.MainActivity" android:exported="true" android:label="@string/host_distribution"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>`,
  );
  fs.writeFileSync(
    path.join(root, "home.xml"),
    `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name="example.host.MainActivity" android:exported="true" android:label="@string/host_distribution"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.HOME"/><category android:name="android.intent.category.DEFAULT"/></intent-filter></activity></application></manifest>`,
  );
  for (const [directory, value] of [
    ["res", "standalone"],
    ["launcher-res", "launcher"],
  ]) {
    for (const locale of ["values", "values-es"]) {
      fs.mkdirSync(path.join(root, directory, locale), { recursive: true });
      fs.writeFileSync(
        path.join(root, directory, locale, "distribution.xml"),
        `<resources><string name="host_distribution">${value}</string></resources>`,
      );
    }
  }
  // The library must link into the host; the companion must build separately.
  for (const [name, plugin, namespace] of [
    ["library", "library", "example.library"],
    ["companion", "application", `${appId}.companion`],
  ]) {
    const module = path.join(root, name);
    fs.mkdirSync(path.join(module, "src/main/java"), { recursive: true });
    fs.writeFileSync(
      path.join(module, "src/main/AndroidManifest.xml"),
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application/></manifest>',
    );
    fs.writeFileSync(
      path.join(module, "build.gradle"),
      `apply plugin: 'com.android.${plugin}'
android {
 namespace '${namespace}'
 compileSdk 36
 defaultConfig { minSdk 29; targetSdk 36 }
}
`,
    );
  }
  fs.writeFileSync(
    path.join(root, "library/src/main/java/BaseActivity.java"),
    "package example.library; public class BaseActivity extends android.app.Activity {}\n",
  );
  fs.mkdirSync(path.join(root, "companion/src/main/assets"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "companion/src/main/assets/companion-only.txt"),
    "separate APK",
  );
  const source = (relative) => ({ root: "consumer", path: relative });
  return {
    identity: {
      appId,
      appName: "Independent Consumer",
      version: "1.0",
      versionCode: 1,
    },
    profile: {
      schema: 1,
      sdk: { min: 29, target: 36, compile: 36 },
      releaseMinify: false,
      modules: [
        { name: "library", source: source("library") },
        {
          name: "companion",
          source: source("companion"),
          appDependency: false,
        },
      ],
      dependencies: [],
      manifest: source("main.xml"),
      flavors: [
        { name: "standalone" },
        { name: "launcher", manifest: source("home.xml") },
      ],
      sourceSets: {
        main: { java: [source("src")], res: [source("res")] },
        launcher: { res: [source("launcher-res")] },
      },
      buildConfigFields: [
        { name: "HOST_LABEL", type: "String", value: 'host "literal" $value' },
      ],
    },
  };
}

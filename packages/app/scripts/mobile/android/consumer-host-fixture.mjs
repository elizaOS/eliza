/** Minimal independent host used only for generated-project qualification. */
import fs from "node:fs";
import path from "node:path";
export function createConsumerFixture(root, appId) {
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src/MainActivity.java"),
    "package example.host; public final class MainActivity extends android.app.Activity {}\n",
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
    fs.mkdirSync(path.join(root, directory, "values"), { recursive: true });
    fs.writeFileSync(
      path.join(root, directory, "values/distribution.xml"),
      `<resources><string name="host_distribution">${value}</string></resources>`,
    );
  }
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
      modules: [],
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

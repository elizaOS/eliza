/** Run existing multi-app consumers under the native runner's device lease. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export async function runConsumerFixture({
  root,
  plugin,
  entry,
  outputDir,
  adb,
  build,
  parseInstrumentation,
  parseNativeArtifacts,
}) {
  const directory = path.join(outputDir, plugin.directory);
  fs.mkdirSync(directory, { recursive: true });
  const project = path.join(root, plugin.consumerProject);
  const notifications = plugin.directory === "plugin-native-notifications";
  const passwords = plugin.directory === "plugin-native-passwords";
  const variants = [
    "host/debug",
    "host/androidTest/debug",
    ...(passwords ? ["fixture/debug"] : []),
    ...(notifications
      ? ["fixture/selected/debug", "fixture/excluded/debug"]
      : []),
  ];
  const ownedPackages = [];
  let user: string | undefined;
  let originalUser = "";
  const save = () =>
    fs.writeFileSync(
      path.join(directory, "consumer.json"),
      JSON.stringify(entry, null, 2),
    );
  const waitUntil = async (check, label) => {
    const deadline = Date.now() + 30_000;
    while (!check()) {
      if (Date.now() >= deadline) throw new Error(label);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const users = () =>
    [...adb("shell", "pm", "list", "users").matchAll(/UserInfo\{(\d+):/g)].map(
      (match) => match[1],
    );
  const foregroundSettled = (id: string) => {
    const state = adb("shell", "dumpsys", "activity", "users");
    return (
      new RegExp(`mCurrentUserId:\\s*${id}\\b`).test(state) &&
      /mTargetUserId:\s*-10000\b/.test(state) &&
      (!state.includes("mPendingTargetUserIds:") ||
        /mPendingTargetUserIds:\s*\[\]/.test(state))
    );
  };
  const cleanup = async () => {
    adb("shell", "am", "switch-user", originalUser);
    await waitUntil(
      () => foregroundSettled(originalUser),
      "Cannot restore foreground user",
    );
    // get-current-user changes before Android finishes the user switch. Retry
    // removal of only our recorded user until that transition has settled.
    entry.cleanupAttempts = [];
    await waitUntil(() => {
      if (!users().includes(user)) return true;
      try {
        adb("shell", "am", "stop-user", "-w", "-f", user);
        entry.cleanupAttempts.push(adb("shell", "pm", "remove-user", user));
      } catch (error) {
        entry.cleanupAttempts.push(String(error));
      }
      return !users().includes(user);
    }, "Consumer user remains installed");
    for (const name of ownedPackages) {
      if (
        adb("shell", "pm", "list", "packages", "-u")
          .split(/\r?\n/)
          .includes(`package:${name}`)
      ) {
        const result = adb("uninstall", name);
        if (!result.includes("Success"))
          throw new Error(`Cannot remove package ${name}: ${result}`);
      }
    }
    entry.cleanup = {
      removedUser: user,
      foregroundAfter: originalUser,
      removedPackages: ownedPackages,
    };
  };
  try {
    if (
      !notifications &&
      !passwords &&
      plugin.directory !== "plugin-native-media"
    )
      throw new Error(`No consumer install protocol for ${plugin.directory}`);
    if (build) {
      const gradle =
        process.env.GRADLE_BIN ||
        path.join(root, "packages/app/platforms/android/gradlew");
      const capacitor =
        process.env.CAPACITOR_ANDROID_DIR ||
        path.join(
          root,
          "packages/app/node_modules/@capacitor/android/capacitor",
        );
      try {
        const log = execFileSync(
          gradle,
          [
            "-p",
            project,
            "--no-daemon",
            "--max-workers=1",
            ":host:assembleDebug",
            ":host:assembleDebugAndroidTest",
            ...(passwords ? [":fixture:assembleDebug"] : []),
            ...(notifications
              ? [
                  ":fixture:assembleSelectedDebug",
                  ":fixture:assembleExcludedDebug",
                ]
              : []),
          ],
          {
            cwd: root,
            env: { ...process.env, CAPACITOR_ANDROID_DIR: capacitor },
            encoding: "utf8",
            timeout: 1_200_000,
            maxBuffer: 32 * 1024 * 1024,
          },
        );
        fs.writeFileSync(path.join(directory, "build.log"), log);
      } catch (error) {
        fs.writeFileSync(
          path.join(directory, "build.log"),
          `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
        );
        throw error;
      }
    }
    const apks = variants.map((variant) => {
      const [module, ...parts] = variant.split("/");
      const output = path.join(project, module, "build/outputs/apk", ...parts);
      const metadata = JSON.parse(
        fs.readFileSync(path.join(output, "output-metadata.json"), "utf8"),
      );
      if (
        !metadata.applicationId.startsWith("example.") ||
        metadata.elements.length !== 1
      )
        throw new Error("Expected a single isolated consumer APK");
      const file = path.join(output, metadata.elements[0].outputFile);
      return {
        file,
        applicationId: metadata.applicationId,
        sha256: createHash("sha256")
          .update(fs.readFileSync(file))
          .digest("hex"),
      };
    });
    entry.apks = apks;
    entry.expectedTests = plugin.consumerTests.reduce(
      (sum, test) => sum + test.count,
      0,
    );
    // Installing updates package code for all users. Refuse pre-existing packages,
    // including retained data, before claiming any ownership or changing the device.
    for (const existingUser of users()) {
      const packages = new Set(
        adb("shell", "pm", "list", "packages", "-u", "--user", existingUser)
          .trim()
          .split(/\r?\n/),
      );
      for (const apk of apks)
        if (packages.has(`package:${apk.applicationId}`))
          throw new Error(
            `Consumer package already exists: ${apk.applicationId}`,
          );
    }
    originalUser = adb("shell", "am", "get-current-user").trim();
    if (!/^\d+$/.test(originalUser))
      throw new Error("Cannot identify foreground user");
    await waitUntil(
      () =>
        foregroundSettled(originalUser) &&
        adb("shell", "am", "get-started-user-state", originalUser).trim() ===
          "RUNNING_UNLOCKED",
      "Emulator foreground user is not ready",
    );
    entry.foregroundBefore = originalUser;
    entry.userName = `Eliza-consumer-${randomUUID()}`;
    save();
    const created = adb("shell", "pm", "create-user", entry.userName);
    user = created.match(/created user id (\d+)/)?.[1];
    if (!user) throw new Error(`Cannot create consumer user: ${created}`);
    entry.user = user;
    save();
    adb("shell", "am", "start-user", "-w", user);
    adb("shell", "am", "switch-user", user);
    await waitUntil(
      () => foregroundSettled(user),
      "Consumer user did not become foreground",
    );
    adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
    adb("shell", "wm", "dismiss-keyguard");
    await waitUntil(
      () =>
        adb("shell", "am", "get-started-user-state", user).trim() ===
        "RUNNING_UNLOCKED",
      "Consumer user did not unlock",
    );
    if (passwords)
      adb(
        "shell",
        "settings",
        "--user",
        user,
        "put",
        "secure",
        "user_setup_complete",
        "1",
      );
    for (const apk of apks) {
      ownedPackages.push(apk.applicationId);
      entry.ownedPackages = ownedPackages;
      save();
      adb("install", "--user", user, "-t", "-g", apk.file);
    }
    const output = adb(
      "shell",
      "am",
      "instrument",
      "--user",
      user,
      "-w",
      "-r",
      ...(notifications ? ["-e", "disposableMirrorFixture", "1"] : []),
      ...(passwords ? ["-e", "disposablePasswordFixture", "1"] : []),
      `${apks[1].applicationId}/androidx.test.runner.AndroidJUnitRunner`,
    );
    fs.writeFileSync(path.join(directory, "instrumentation.txt"), output);
    entry.artifacts = parseNativeArtifacts(output).map(({ name, bytes }) => {
      const file = path.join(directory, name);
      fs.writeFileSync(file, bytes);
      return {
        path: path.relative(root, file),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    });
    Object.assign(entry, parseInstrumentation(output, entry.expectedTests));
  } catch (error) {
    entry.pass = false;
    entry.problems.push(String(error));
  } finally {
    if (user) {
      try {
        await cleanup();
      } catch (error) {
        entry.pass = false;
        entry.problems.push(`Consumer cleanup: ${error}`);
      }
    }
    save();
  }
}

/** Exercises real Android settings activities and role-dialog cancellation through Capacitor. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AndroidDevice, TestInfo } from "@playwright/test";
import { testOutputPath } from "../../../scripts/lib/test-output.ts";
import { captureAndroidScreenshot } from "../../scripts/lib/android-capture.ts";
import {
  APP_ID,
  adbDevice,
  foregroundApp,
  resolveAdb,
} from "../../scripts/lib/android-device.ts";
import { expect, test, waitForShellReady } from "./android-harness";

const artifactDir = path.join(
  process.env.ELIZA_ANDROID_ARTIFACT_DIR ?? testOutputPath("app", "android"),
  "native-system-intents",
);

const screens = [
  {
    method: "openSettings",
    selector: { text: /^Settings$/ },
    action: "android.settings.SETTINGS",
  },
  {
    method: "openNetworkSettings",
    selector: { text: /^(Internet|Wi-Fi)$/ },
    action: "android.settings.WIFI_SETTINGS",
  },
  {
    method: "openDisplaySettings",
    selector: { desc: /^Display(?: & touch)?$/ },
    action: "android.settings.DISPLAY_SETTINGS",
  },
  {
    method: "openSoundSettings",
    selector: { desc: /^Sound & vibration$/ },
    action: "android.settings.SOUND_SETTINGS",
  },
  {
    method: "openWriteSettings",
    selector: { text: /^Modify system settings$/ },
    action: "android.settings.action.MANAGE_WRITE_SETTINGS",
  },
] as const;

async function attachNativeState(
  device: AndroidDevice,
  info: TestInfo,
  name: string,
  receipt: unknown,
) {
  fs.mkdirSync(artifactDir, { recursive: true });
  const screenshot = captureAndroidScreenshot({
    serial: device.serial(),
    artifactDir,
    filename: `${name}.png`,
  });
  await info.attach(name, { path: screenshot, contentType: "image/png" });
  const output = path.join(artifactDir, `${name}.json`);
  fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`);
  await info.attach(`${name} native observations`, {
    path: output,
    contentType: "application/json",
  });
}

test.beforeEach(async ({ page, device }) => {
  expect(
    device.serial(),
    "native settings tests require the isolated stock emulator",
  ).toMatch(/^emulator-/);
  await waitForShellReady(page);
  expect(await page.evaluate(() => window.Capacitor?.getPlatform?.())).toBe(
    "android",
  );
  expect(
    await page.evaluate(() =>
      window.Capacitor?.isPluginAvailable?.("ElizaSystem"),
    ),
  ).toBe(true);
});

for (const screen of screens) {
  test(`${screen.method} opens its actual Android settings screen`, async ({
    page,
    device,
  }, info) => {
    test.setTimeout(60_000);
    const adb = resolveAdb();
    const before = await page.evaluate(() =>
      window.Capacitor.Plugins.ElizaSystem.getDeviceSettings(),
    );
    // Reproduce an existing settings task whose requested root is covered by
    // another screen. NEW_TASK alone can resume the wrong top activity.
    if (screen.method === "openNetworkSettings") {
      adbDevice(adb, device.serial(), [
        "shell",
        "am",
        "force-stop",
        "com.android.settings",
      ]);
      await page.evaluate(async () => {
        await window.Capacitor.Plugins.ElizaSystem.openNetworkSettings();
        await window.Capacitor.Plugins.ElizaSystem.openSoundSettings();
      });
      await expect(async () => {
        expect(
          (
            await device.info({
              pkg: "com.android.settings",
              desc: /^Sound & vibration$/,
            })
          ).bounds.width,
        ).toBeGreaterThan(0);
      }).toPass({ timeout: 15_000 });
      foregroundApp(adb, device.serial());
    }
    const marker = randomUUID();
    adbDevice(adb, device.serial(), [
      "shell",
      "log",
      "-t",
      "ELIZA_SYSTEM_INTENT_TEST",
      marker,
    ]);
    try {
      await page.evaluate(async (method) => {
        await window.Capacitor.Plugins.ElizaSystem[method]();
      }, screen.method);
      await expect(async () => {
        const title = await device.info({
          pkg: "com.android.settings",
          ...screen.selector,
        });
        expect(title.bounds.width).toBeGreaterThan(0);
      }).toPass({ timeout: 15_000 });
      const activities = adbDevice(adb, device.serial(), [
        "shell",
        "dumpsys",
        "activity",
        "activities",
      ]);
      expect(activities).toMatch(
        /topResumedActivity=ActivityRecord\{[^\n]* com\.android\.settings\//,
      );
      const logcat = adbDevice(adb, device.serial(), [
        "logcat",
        "-d",
        "-v",
        "brief",
        "-s",
        "ELIZA_SYSTEM_INTENT_TEST:I",
        "ActivityTaskManager:I",
        "*:S",
      ]);
      const markerIndex = logcat.lastIndexOf(marker);
      expect(
        markerIndex,
        "native log marker must identify this invocation",
      ).toBeGreaterThanOrEqual(0);
      const launchLog = logcat.slice(markerIndex);
      expect(launchLog).toContain(`act=${screen.action}`);
      if (screen.method === "openWriteSettings") {
        // Android redacts the package URI in ActivityTaskManager logs. Verify
        // the app-specific settings page identifies the installed Eliza app.
        expect(launchLog).toContain("dat=package:");
        expect(
          (await device.info({ pkg: "com.android.settings", text: "Eliza" }))
            .bounds.width,
        ).toBeGreaterThan(0);
      }
      await attachNativeState(device, info, screen.method, {
        method: screen.method,
        expectedAction: screen.action,
        nativeTitle: await device.info({
          pkg: "com.android.settings",
          ...screen.selector,
        }),
        activities,
        launchLog,
      });
    } catch (error) {
      await attachNativeState(device, info, `${screen.method}-failure`, {
        error: String(error),
        activities: adbDevice(adb, device.serial(), [
          "shell",
          "dumpsys",
          "activity",
          "activities",
        ]),
      });
      throw error;
    } finally {
      foregroundApp(adb, device.serial());
    }
    const after = await page.evaluate(() =>
      window.Capacitor.Plugins.ElizaSystem.getDeviceSettings(),
    );
    expect(after).toEqual(before);
  });
}

test("invalid role rejects without changing Android role holders", async ({
  page,
  device,
}, info) => {
  const before = await page.evaluate(() =>
    window.Capacitor.Plugins.ElizaSystem.getStatus(),
  );
  const result = await page.evaluate(async () => {
    try {
      await window.Capacitor.Plugins.ElizaSystem.requestRole({
        role: "not-an-android-role",
      });
      return { resolved: true, error: null };
    } catch (error) {
      return {
        resolved: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
  expect(result.resolved).toBe(false);
  expect(result.error).toContain(
    "role must be one of home, dialer, sms, assistant",
  );
  const after = await page.evaluate(() =>
    window.Capacitor.Plugins.ElizaSystem.getStatus(),
  );
  expect(after).toEqual(before);
  await attachNativeState(device, info, "invalid-role", {
    before,
    result,
    after,
  });
});

test("cancelling the native dialer-role picker resolves denied and preserves the default phone app", async ({
  page,
  device,
}, info) => {
  test.setTimeout(60_000);
  const adb = resolveAdb();
  const holders = () =>
    adbDevice(adb, device.serial(), [
      "shell",
      "cmd",
      "role",
      "get-role-holders",
      "android.app.role.DIALER",
    ]).trim();
  const before = holders();
  expect(before).not.toBe(APP_ID);
  const status = await page.evaluate(() =>
    window.Capacitor.Plugins.ElizaSystem.getStatus(),
  );
  expect(
    status.roles.find((role: { role: string }) => role.role === "dialer"),
  ).toMatchObject({ available: true, held: false });
  const pending = page.evaluate(() =>
    window.Capacitor.Plugins.ElizaSystem.requestRole({ role: "dialer" }),
  );
  // Attach a rejection handler immediately while Android owns the foreground.
  const outcome = pending.then(
    (value) => ({ value }),
    (error) => ({ error: String(error) }),
  );
  try {
    await expect(async () => {
      expect(
        (await device.info({ pkg: /.*permissioncontroller/ })).bounds.width,
      ).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });
    await attachNativeState(device, info, "dialer-picker-opened", {
      before,
      nativeUi: await device.info({ pkg: /.*permissioncontroller/ }),
    });
    await expect(async () => {
      const title = await device.info({
        text: /.*default phone app.*/i,
      });
      expect(title.pkg).not.toBe(APP_ID);
      expect(title.bounds.width).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });
    await attachNativeState(device, info, "dialer-role-picker", {
      before,
      status,
    });
    await device.input.press("Back");
    const result = await outcome;
    expect(result).toEqual({
      value: { role: "dialer", held: false, resultCode: 0 },
    });
    expect(holders()).toBe(before);
    await attachNativeState(device, info, "dialer-role-cancelled", {
      before,
      result,
      after: holders(),
    });
  } catch (error) {
    await attachNativeState(device, info, "dialer-picker-failure", {
      error: String(error),
      before,
      after: holders(),
    });
    throw error;
  } finally {
    await device.input.press("Back");
    foregroundApp(adb, device.serial());
  }
});

test("granting the dialer role returns the Android result and restores the original phone app", async ({
  page,
  device,
}, info) => {
  test.setTimeout(60_000);
  expect(
    device.serial(),
    "role changes require the isolated emulator fixture",
  ).toMatch(/^emulator-/);
  const adb = resolveAdb();
  const holders = () =>
    adbDevice(adb, device.serial(), [
      "shell",
      "cmd",
      "role",
      "get-role-holders",
      "android.app.role.DIALER",
    ]).trim();
  const before = holders();
  expect(before).toMatch(/^[a-zA-Z0-9_.]+$/);
  expect(before).not.toBe(APP_ID);
  const restore = () =>
    adbDevice(adb, device.serial(), [
      "shell",
      "cmd",
      "role",
      "add-role-holder",
      "--user",
      "0",
      "android.app.role.DIALER",
      before,
    ]);
  // Prove restoration authority before changing the holder through Android UI.
  restore();
  expect(holders()).toBe(before);
  const pending = page.evaluate(() =>
    window.Capacitor.Plugins.ElizaSystem.requestRole({ role: "dialer" }),
  );
  const outcome = pending.then(
    (value) => ({ value }),
    (error) => ({ error: String(error) }),
  );
  try {
    await expect(async () => {
      expect(
        (await device.info({ pkg: /.*permissioncontroller/, text: "Eliza" }))
          .bounds.width,
      ).toBeGreaterThan(0);
    }).toPass({ timeout: 15_000 });
    await device.tap({ pkg: /.*permissioncontroller/, text: "Eliza" });
    await device.tap({
      pkg: /.*permissioncontroller/,
      text: "Set as default",
      enabled: true,
    });
    const result = await outcome;
    expect(result).toEqual({
      value: { role: "dialer", held: true, resultCode: -1 },
    });
    await expect.poll(holders).toBe(APP_ID);
    const status = await page.evaluate(() =>
      window.Capacitor.Plugins.ElizaSystem.getStatus(),
    );
    expect(
      status.roles.find((role: { role: string }) => role.role === "dialer"),
    ).toMatchObject({ held: true, holders: [APP_ID] });
    const alreadyHeld = await page.evaluate(() =>
      window.Capacitor.Plugins.ElizaSystem.requestRole({ role: "dialer" }),
    );
    expect(alreadyHeld).toEqual({ role: "dialer", held: true, resultCode: 0 });
    await attachNativeState(device, info, "dialer-granted", {
      before,
      result,
      androidHolder: holders(),
      status,
      alreadyHeld,
    });
  } finally {
    restore();
    await expect.poll(holders).toBe(before);
    await device.input.press("Back");
    foregroundApp(adb, device.serial());
    await attachNativeState(device, info, "dialer-restored", {
      before,
      restored: holders(),
    });
  }
});

/**
 * Executes the Android Cloud-onboarding package commands across a controlled
 * process boundary, recording the child argv and lane environment without
 * building, installing, or connecting to a device. The Playwright collection
 * check then proves those arguments select only the operator-driven live spec.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const playwrightCli = path.resolve(
  appRoot,
  "../../node_modules/playwright/cli.js",
);

function installRecorder(fakeBin, tool, recorderPath) {
  const executable = path.join(
    fakeBin,
    process.platform === "win32" ? `${tool}.cmd` : tool,
  );
  const command =
    process.platform === "win32"
      ? `@"${process.execPath}" "${recorderPath}" "${tool}" %*\r\n`
      : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(recorderPath)} ${JSON.stringify(tool)} "$@"\n`;
  writeFileSync(executable, command);
  if (process.platform !== "win32") chmodSync(executable, 0o755);
}

function runPackageScript(scriptName, interceptedTools) {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "android-cloud-command-"),
  );
  const recordPath = path.join(fixtureRoot, "calls.jsonl");
  const recorderPath = path.join(fixtureRoot, "record.mjs");
  writeFileSync(
    recorderPath,
    `import { appendFileSync } from "node:fs";
const [tool, ...argv] = process.argv.slice(2);
appendFileSync(process.env.ELIZA_COMMAND_RECORD, JSON.stringify({
  tool,
  argv,
  env: {
    live: process.env.ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE ?? null,
    allowFirstRun: process.env.ELIZA_ANDROID_ALLOW_FIRST_RUN ?? null,
    requireAgent: process.env.ELIZA_ANDROID_REQUIRE_AGENT ?? null,
    clearAppData: process.env.ELIZA_ANDROID_CLEAR_APP_DATA ?? null,
    privilegedTokenPresent: Boolean(process.env.ELIZA_CLOUD_AUTH_TOKEN),
  },
}) + "\\n");
`,
  );
  for (const tool of interceptedTools) {
    installRecorder(fixtureRoot, tool, recorderPath);
  }

  const env = {
    ...process.env,
    ELIZA_COMMAND_RECORD: recordPath,
    PATH: `${fixtureRoot}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  delete env.ELIZA_CLOUD_AUTH_TOKEN;
  try {
    const result = spawnSync(process.execPath, ["run", scriptName], {
      cwd: appRoot,
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    return readFileSync(recordPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
  }
}

test("the public lane executes build, install, and one locked Playwright spec", () => {
  expect(
    runPackageScript("test:e2e:android:cloud-onboarding", ["bun", "bunx"]),
  ).toEqual([
    {
      tool: "bun",
      argv: ["run", "build:android:cloud:debug"],
      env: {
        live: "1",
        allowFirstRun: null,
        requireAgent: null,
        clearAppData: null,
        privilegedTokenPresent: false,
      },
    },
    {
      tool: "bun",
      argv: ["run", "install:android:adb"],
      env: {
        live: null,
        allowFirstRun: null,
        requireAgent: null,
        clearAppData: null,
        privilegedTokenPresent: false,
      },
    },
    {
      tool: "bunx",
      argv: [
        "playwright",
        "test",
        "--config",
        "playwright.android.config.ts",
        "test/android/cloud-onboarding.android.spec.ts",
      ],
      env: {
        live: "1",
        allowFirstRun: "1",
        requireAgent: "0",
        clearAppData: "1",
        privilegedTokenPresent: false,
      },
    },
  ]);
});

test("the build and install aliases dispatch their executable argv", () => {
  expect(runPackageScript("build:android:cloud:debug", ["node"])).toEqual([
    {
      tool: "node",
      argv: [
        "../../packages/app-core/scripts/run-mobile-build.mjs",
        "android-cloud-debug",
      ],
      env: {
        live: null,
        allowFirstRun: null,
        requireAgent: null,
        clearAppData: null,
        privilegedTokenPresent: false,
      },
    },
  ]);
  expect(runPackageScript("install:android:adb", ["node"])).toEqual([
    {
      tool: "node",
      argv: ["scripts/android-adb-install.mjs"],
      env: {
        live: null,
        allowFirstRun: null,
        requireAgent: null,
        clearAppData: null,
        privilegedTokenPresent: false,
      },
    },
  ]);
});

test("the executable Playwright argv collects only the three live acceptance legs", () => {
  const result = spawnSync(
    process.platform === "win32" ? "node.exe" : "node",
    [
      playwrightCli,
      "test",
      "--config",
      "playwright.android.config.ts",
      "test/android/cloud-onboarding.android.spec.ts",
      "--list",
    ],
    {
      cwd: appRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        ELIZA_DEVICE_CLOUD_ONBOARDING_LIVE: "1",
        ELIZA_ANDROID_ALLOW_FIRST_RUN: "1",
        ELIZA_ANDROID_REQUIRE_AGENT: "0",
        ELIZA_ANDROID_CLEAR_APP_DATA: "1",
      },
      timeout: 20_000,
    },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  expect(result.error, output).toBeUndefined();
  expect(result.status, output).toBe(0);
  expect(output).toContain(
    "stale local and embedded-wallet state cannot bypass Cloud sign-in",
  );
  expect(output).toContain(
    "mobile-PKCE handoff closes into signed-out recovery",
  );
  expect(output).toContain(
    "Google returns by PKCE callback and reaches streamed chat",
  );
  expect(output).toMatch(/Total:\s+3 tests/);
});

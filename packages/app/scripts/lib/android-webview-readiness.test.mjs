import assert from "node:assert/strict";
import test from "node:test";
import {
  androidWebViewReady,
  waitForAndroidWebView,
} from "./android-webview-readiness.mjs";

const ready = `Current WebView Update Service state
  Current WebView package (name, version): (com.android.webview, 157.0.8083.0)
  Number of relros started: 1
  Number of relros finished: 1
  WebView package dirty: false
  Any WebView package installed: true
  WebView packages:
    Valid package com.android.webview (versionName: 157.0.8083.0, versionCode: 808300007, targetSdkVersion: 37) is  installed/enabled for all users
`;

test("requires selected provider, complete RELRO and installation for every user", () => {
  assert.equal(androidWebViewReady(ready), true);
  for (const state of [
    "",
    ready.replace("package dirty: false", "package dirty: true"),
    ready.replace("relros finished: 1", "relros finished: 0"),
    ready.replaceAll("relros started: 1", "relros started: 0"),
    ready.replace("package installed: true", "package installed: false"),
    ready.replace("is  installed/enabled", "is NOT installed/enabled"),
    ready.replace(
      "Valid package com.android.webview",
      "Valid package com.other.webview",
    ),
    ready.replace("Valid package", "Invalid package"),
  ])
    assert.equal(androidWebViewReady(state), false, state);
});

test("waits for secondary-user provider work with read-only commands and retains admission evidence", async () => {
  const commands = [],
    observations = [];
  let reads = 0;
  await waitForAndroidWebView({
    user: 11,
    pollMs: 1,
    execute: async (args) => {
      commands.push(args.join(" "));
      if (args.join(" ") === "shell am get-current-user") return "11\n";
      assert.deepEqual(args, ["shell", "dumpsys", "webviewupdate"]);
      return ++reads === 1
        ? ready.replace("relros finished: 1", "relros finished: 0")
        : ready;
    },
    record: (value) => observations.push(value),
  });
  assert.deepEqual(
    observations.map(({ ready }) => ready),
    [false, true],
  );
  assert.equal(commands.length, 4);
});

test("foreground drift and command failure stop admission without retries", async () => {
  let calls = 0;
  await assert.rejects(
    waitForAndroidWebView({
      user: 11,
      execute: async () => {
        calls++;
        return "0";
      },
      record: () => assert.fail("No provider observation on foreign user"),
    }),
    /Owned Android user changed/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    waitForAndroidWebView({
      user: 11,
      execute: async () => {
        calls++;
        throw new Error("device offline");
      },
      record: () => {},
    }),
    /device offline/,
  );
  assert.equal(calls, 1);
});

test("deadline aborts a live command and cancellation stops before any device command", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    waitForAndroidWebView({
      user: 11,
      signal: controller.signal,
      execute: async () => assert.fail("Cancelled command"),
      record: () => {},
    }),
    { name: "AbortError" },
  );
  // Keep the test process alive while the deadline's unreferenced timer runs.
  const hold = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      waitForAndroidWebView({
        user: 11,
        timeoutMs: 20,
        execute: async (_args, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
        record: () => {},
      }),
      /WebView readiness deadline exceeded/,
    );
  } finally {
    clearInterval(hold);
  }
});

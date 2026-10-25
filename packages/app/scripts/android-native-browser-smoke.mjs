#!/usr/bin/env node
/** Exercises the installed app's authenticated local API, Binder broker and real background Chromium extension. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const { values } = parseArgs({ options: { serial: { type: "string" } } });
if (!values.serial) throw new Error("Use --serial DEVICE");
const adb = (...args) =>
  execFileSync("adb", ["-s", values.serial, ...args], { timeout: 30000 });
const out = testOutputPath("android-native-browser");
await mkdir(out, { recursive: true });
const text = "Complete Android background context 最後🙂 ".repeat(20000);
const childText = "Complete child frame context 子フレーム🙂 ".repeat(10000);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const contextBlock = (name, value) =>
  `<pre>BEGIN-${name}\n${value}\nEND-${name}</pre>`;
const transcript = [];
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url === "/child") {
    res.end(
      `<title>Eliza child fixture</title>${contextBlock("child", childText)}`,
    );
    return;
  }
  res.end(
    `<title>Eliza background fixture</title><button onclick="const counter=document.querySelector('#count');counter.textContent='Count: '+(Number(counter.textContent.slice(7))+1)">Increment</button><span id="count">Count: 0</span><input aria-label="Fixture input" oninput="document.querySelector('#value').textContent='Value: '+this.value"><span id="value"></span><iframe src="/child" title="Child context"></iframe>${contextBlock("main", text)}`,
  );
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser, id, request, profileId, failure;
const foreground = () =>
  adb("shell", "dumpsys", "activity", "activities")
    .toString()
    .split("\n")
    .filter((line) => line.includes("topResumedActivity"));
try {
  const pid = adb("shell", "pidof", "ai.elizaos.app").toString().trim();
  assert.match(pid, /^\d+$/);
  adb("forward", "tcp:19823", `localabstract:webview_devtools_remote_${pid}`);
  adb("reverse", "tcp:19825", `tcp:${server.address().port}`);
  browser = await chromium.connectOverCDP("http://127.0.0.1:19823");
  const page = browser.contexts()[0].pages()[0];
  request = async (path, body) => {
    const response = await page.evaluate(
      async ({ path, body }) =>
        window.Capacitor.nativePromise("Agent", "request", {
          path,
          method: body === undefined ? "GET" : "POST",
          ...(body === undefined
            ? {}
            : {
                body: JSON.stringify(body),
                headers: { "Content-Type": "application/json" },
              }),
          timeoutMs: 45000,
        }),
      { path, body },
    );
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Native API ${response.status}: ${response.body}`);
    return JSON.parse(response.body);
  };
  const status = await request("/api/browser-device");
  assert.equal(
    status.connected,
    true,
    "The installed runtime must own a connected Chromium profile",
  );
  profileId = status.profileId;
  const command = async (command) => {
    const startedAt = new Date().toISOString();
    try {
      const response = await request("/api/browser-device/command", {
        profileId,
        command,
      });
      transcript.push({ startedAt, command, response });
      return response;
    } catch (error) {
      transcript.push({ startedAt, command, error: String(error) });
      throw error;
    }
  };
  adb("shell", "am", "start", "-a", "android.settings.SETTINGS");
  const before = foreground();
  assert.ok(before.some((line) => line.includes("com.android.settings")));
  const opened = await command({
    subaction: "open",
    url: "http://127.0.0.1:19825/",
  });
  id = opened.value.result.id;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const snapshot = await command({ subaction: "snapshot", id });
  const frames = snapshot.value.result.frames;
  const frame = frames.find((item) => item.url === "http://127.0.0.1:19825/");
  assert.ok(frame, "The main fixture frame must be present");
  const contextEvidence = [
    { name: "main", url: "http://127.0.0.1:19825/", expected: text },
    { name: "child", url: "http://127.0.0.1:19825/child", expected: childText },
  ].map(({ name, url, expected }) => {
    const observedFrame = frames.find((item) => item.url === url);
    assert.ok(observedFrame, `Missing ${name} frame`);
    assert.equal(observedFrame.complete, true);
    const begin = `BEGIN-${name}\n`;
    const end = `\nEND-${name}`;
    const start = observedFrame.text.indexOf(begin);
    assert.ok(start >= 0, `Missing ${name} context start`);
    const stop = observedFrame.text.indexOf(end, start + begin.length);
    assert.ok(stop >= 0, `Missing ${name} context end`);
    const observed = observedFrame.text.slice(start + begin.length, stop);
    assert.equal(
      observed,
      expected,
      `Full ${name} context must survive native framing`,
    );
    return {
      name,
      url,
      expectedCharacters: expected.length,
      observedCharacters: observed.length,
      expectedBytes: Buffer.byteLength(expected),
      observedBytes: Buffer.byteLength(observed),
      expectedSha256: sha256(expected),
      observedSha256: sha256(observed),
    };
  });
  const button = frame.elements.find(
    (element) => element.label === "Increment",
  );
  assert.ok(button);
  const receipt = await command({
    subaction: "click",
    id,
    selector: button.selector,
  });
  assert.equal(receipt.value.result.completed, false);
  await assert.rejects(
    command({ subaction: "click", id, selector: button.selector }),
    /fresh snapshot/,
  );
  const clicked = await command({ subaction: "snapshot", id });
  const mainFrame = (response) =>
    response.value.result.frames.find((item) => item.url === frame.url);
  assert.equal(Number(mainFrame(clicked).text.match(/Count: (\d+)/)?.[1]), 1);
  const input = mainFrame(clicked).elements.find(
    (element) => element.tag === "input",
  );
  assert.ok(input);
  await command({
    subaction: "fill",
    id,
    selector: input.selector,
    text: "Android fixture",
  });
  const filled = await command({ subaction: "snapshot", id });
  assert.ok(mainFrame(filled).text.includes("Value: Android fixture"));
  assert.equal(Number(mainFrame(filled).text.match(/Count: (\d+)/)?.[1]), 1);
  const tabs = await command({ subaction: "list" });
  assert.equal(
    tabs.value.result.tabs.find((tab) => tab.id === id).active,
    false,
  );
  const after = foreground();
  assert.deepEqual(
    after,
    before,
    "Browser effects must not steal Android foreground",
  );
  const report = {
    serial: values.serial,
    timestamp: new Date().toISOString(),
    profileId,
    completeTextCharacters: text.length + childText.length,
    contextEvidence,
    observedClickCount: 1,
    backgroundTab: true,
    nativeClickVerified: true,
    nativeFillVerified: true,
    staleReferenceRejected: true,
    foreground: after,
  };
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await writeFile(`${out}/background.png`, adb("exec-out", "screencap", "-p"));
  console.log(JSON.stringify(report));
} catch (error) {
  failure = error;
  throw error;
} finally {
  await writeFile(
    `${out}/transcript.json`,
    JSON.stringify(transcript, null, 2),
  );
  if (id && request && !failure)
    await request("/api/browser-device/command", {
      profileId,
      command: { subaction: "close", id },
    });
  await browser?.close();
  adb("reverse", "--remove", "tcp:19825");
  adb("forward", "--remove", "tcp:19823");
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

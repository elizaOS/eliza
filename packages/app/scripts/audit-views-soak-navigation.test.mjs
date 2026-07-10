/**
 * Behavioral contracts for the real-app soak's navigation, onboarding, and
 * required-evidence failure boundary.
 */

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  convertSoakRecordingToMp4,
  finalizeSoakEvidence,
  waitForOnboardingClearance,
} from "./audit-views-soak-boundary.mjs";

const source = readFileSync(
  new URL("./audit-views-soak.mjs", import.meta.url),
  "utf8",
);

test("cleanup navigates through the shell event instead of raw History", () => {
  expect(source).toContain(
    'await dispatchShellNavigation({ id: "chat", path: "/chat" });',
  );
  expect(source).not.toContain("window.history.pushState");
  expect(source).not.toContain("window.history.replaceState");
});

test("context teardown owns video finalization without swallowed failures", () => {
  expect(source).not.toContain("ctx.close().catch");
  expect(source).not.toContain("await page.close()");
});

test("required screenshot, context close, and video lookup failures reject", async () => {
  const base = {
    page: { screenshot: async () => {} },
    context: { close: async () => {} },
    video: { path: async () => "/tmp/soak.webm" },
    outDir: "/tmp/out",
    convertRecording: () => {},
  };
  await expect(
    finalizeSoakEvidence({
      ...base,
      page: { screenshot: async () => Promise.reject(new Error("shot")) },
    }),
  ).rejects.toThrow("shot");
  await expect(
    finalizeSoakEvidence({
      ...base,
      context: { close: async () => Promise.reject(new Error("close")) },
    }),
  ).rejects.toThrow("close");
  await expect(
    finalizeSoakEvidence({
      ...base,
      video: { path: async () => Promise.reject(new Error("video")) },
    }),
  ).rejects.toThrow("video");
});

test("successful evidence finalization produces the required MP4", async () => {
  const calls = [];
  const artifact = await finalizeSoakEvidence({
    page: { screenshot: async (options) => calls.push(["shot", options.path]) },
    context: { close: async () => calls.push(["close"]) },
    video: { path: async () => "/tmp/recording.webm" },
    outDir: "/tmp/out",
    convertRecording: (sourcePath, targetPath) =>
      calls.push(["convert", sourcePath, targetPath]),
  });
  expect(artifact).toBe("audit-views-soak.mp4");
  expect(calls).toEqual([
    ["shot", join("/tmp/out", "soak-final.png")],
    ["close"],
    ["convert", "/tmp/recording.webm", join("/tmp/out", artifact)],
  ]);
});

test("missing required video rejects while an intentional VIDEO=0 run succeeds", async () => {
  const base = {
    page: { screenshot: async () => {} },
    context: { close: async () => {} },
    video: null,
    outDir: "/tmp/out",
  };
  await expect(finalizeSoakEvidence(base)).rejects.toThrow(
    "recording is required",
  );
  await expect(
    finalizeSoakEvidence({ ...base, videoRequired: false }),
  ).resolves.toBeNull();
});

test("MP4 conversion surfaces ffmpeg launch and encoding failures", () => {
  expect(() =>
    convertSoakRecordingToMp4("input.webm", "output.mp4", {
      spawn: () => ({ error: new Error("ffmpeg missing") }),
    }),
  ).toThrow("ffmpeg missing");
  expect(() =>
    convertSoakRecordingToMp4("input.webm", "output.mp4", {
      spawn: () => ({ status: 1, stderr: "encoder failed", stdout: "" }),
    }),
  ).toThrow("encoder failed");
});

test("onboarding clearance failures reject instead of being ignored", async () => {
  const page = {
    getByTestId: () => ({
      waitFor: async () => Promise.reject(new Error("still attached")),
      isVisible: async () => true,
    }),
  };
  await expect(waitForOnboardingClearance(page, 1)).rejects.toThrow(
    "still attached",
  );
});

test("onboarding clearance rejects a rendered blocker that remains visible", async () => {
  const page = {
    getByTestId: () => ({
      waitFor: async () => {},
      isVisible: async () => true,
    }),
  };
  await expect(waitForOnboardingClearance(page, 1)).rejects.toThrow(
    "onboarding still blocks",
  );
});

test("the soak completes current in-chat onboarding before view churn", () => {
  expect(source).toContain("async function waitForRuntimeReady");
  expect(source).toContain("/api/health");
  expect(source).toContain('attempt.value.body.runtime === "ok"');
  expect(source.indexOf("await waitForRuntimeReady()")).toBeLessThan(
    source.indexOf("await completeFirstRunIfNeeded()"),
  );
  expect(source).toContain(
    'localStorage.setItem("eliza:first-run-complete", "1")',
  );
  expect(source).toContain(
    'localStorage.setItem("eliza:setup:step", "activate")',
  );
  expect(source).toContain("/api/first-run/status");
  expect(source).toContain("/api/first-run");
  expect(source).toContain("await waitForOnboardingClearance(page)");
  expect(source).not.toContain("first-run-runtime-chooser");
});

test("the soak recognizes unavailable optional services and protected boundaries", () => {
  expect(source).toContain('"/api/meetings"');
  expect(source).toContain('"/api/lifeops/todos"');
  expect(source).toContain('"/api/cloud/status"');
  expect(source).toContain("entry.status === 401");
  expect(source).toContain("protected_route_without_session");
});

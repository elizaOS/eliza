import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startLiveApiServer, type TestApiServer } from "./live-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

/**
 * Cloud onboarding ends with a "Restart Milady" CTA whose path ultimately
 * lands in `DesktopManager.relaunch()` (see
 * `eliza/packages/app-core/platforms/electrobun/src/native/desktop.ts:1439`).
 * That handler calls `Bun.spawn([process.execPath, ...process.argv.slice(1)])`
 * and then `Utils.quit()`. On packaged builds `process.execPath` resolves to
 * the launcher binary inside the .app/.exe bundle — if that binary is missing
 * or unreadable the spawn fails. The handler swallows the error via
 * `logger.error(...)` but the process still exits, so a regression that
 * resolves `execPath` to a non-existent path manifests as: shell quits, no
 * new instance comes up. This e2e drives the actual menu action through the
 * loopback test bridge and asserts the parent process exits cleanly without
 * a crash signal.
 *
 * Gated on macOS/Windows — the test requires a packaged launcher binary
 * (the only host configurations where one is built in CI).
 */

test.describe.configure({ mode: "serial" });

function isPackagedPlatform(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

async function waitForProcessExit(
  harness: PackagedDesktopHarness,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const child = harness.process;
  if (!child) {
    throw new Error(
      "Packaged harness has no spawned process to wait on — start() must run first.",
    );
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(
        new Error(
          `Packaged process did not exit after relaunch within ${timeoutMs}ms.`,
        ),
      );
    }, timeoutMs);
    const onExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    child.once("exit", onExit);
  });
}

function combinedLogs(harness: PackagedDesktopHarness): string {
  const stdout = harness.logs?.stdout.join("") ?? "";
  const stderr = harness.logs?.stderr.join("") ?? "";
  return `${stdout}\n${stderr}`;
}

test.describe("Electrobun relaunch after cloud onboarding", () => {
  test("relaunch menu action triggers native restart without crash", async () => {
    test.skip(
      !isPackagedPlatform(),
      "Packaged relaunch regression requires a macOS or Windows launcher.",
    );

    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "eliza-relaunch-e2e-"),
    );
    const extractDir = path.join(tempRoot, "extract");
    const launcherPath = await resolvePackagedLauncher(extractDir);

    expect(
      launcherPath,
      "Packaged launcher is required for the relaunch regression test.",
    ).toBeTruthy();

    let api: TestApiServer | null = null;
    let harness: PackagedDesktopHarness | null = null;

    try {
      api = await startLiveApiServer({ onboardingComplete: true, port: 0 });
      harness = new PackagedDesktopHarness({
        tempRoot,
        launcherPath: launcherPath as string,
        apiBase: api.baseUrl,
      });

      await harness.start({
        bridgeHealthTimeoutMs: 300_000,
        shellReadyTimeoutMs: process.env.CI ? 120_000 : 60_000,
      });

      const parentPidBeforeRelaunch = harness.process?.pid ?? null;
      expect(
        parentPidBeforeRelaunch,
        "Expected the packaged launcher to have a PID after start().",
      ).not.toBeNull();

      // The native `relaunch` menu action runs the exact same code path the
      // cloud-provisioning "Restart Milady" CTA hits via `relaunchDesktop()`
      // → `desktopRelaunch` RPC → `DesktopManager.relaunch()`. Driving the
      // menu action directly is the cleanest way to exercise the native
      // handler without depending on the full cloud-provisioning UI flow,
      // which has its own (already unit-tested) state machine.
      await harness.menuAction("relaunch");

      // After menu-action("relaunch") the desktop manager calls
      // `Bun.spawn(...)` with `detached: true` and then `Utils.quit()`. The
      // parent must exit on its own — we wait for that exit event rather
      // than calling stop(), so we can observe the natural exit code/signal.
      const exit = await waitForProcessExit(harness, 60_000);

      const logs = combinedLogs(harness);

      // The relaunch handler must not have logged a spawn failure. If it did,
      // `process.execPath` resolved to something unspawnable.
      expect(
        logs,
        `Relaunch handler logged a spawn failure:\n${logs}`,
      ).not.toMatch(
        /\[DesktopManager\] relaunch: failed to spawn new instance/,
      );

      // Crash markers across platforms — segfault, BUS, abort, fatal startup.
      expect(
        logs,
        `Relaunch logs contained a crash marker:\n${logs}`,
      ).not.toMatch(
        /SIGSEGV|SIGBUS|SIGABRT|Fatal error during startup|panic:|core dumped/i,
      );

      // A clean quit lands as exit code 0 with no signal. macOS's
      // `Utils.quit()` typically returns 0; Windows may return null+SIGTERM
      // if the parent is terminated by the OS while child finishes detaching.
      // Reject signals that indicate a crash (SIGSEGV/SIGBUS/SIGABRT). Accept
      // a clean exit, a graceful SIGTERM (Windows housekeeping), or null
      // exitCode paired with a non-crash signal.
      if (exit.signal !== null) {
        expect(
          ["SIGTERM", "SIGINT", "SIGHUP"],
          `Unexpected exit signal after relaunch: ${exit.signal}`,
        ).toContain(exit.signal);
      } else {
        expect(
          exit.code,
          `Relaunch exit code should be 0, got ${exit.code}.`,
        ).toBe(0);
      }

      // Null out harness.process so the finally-block cleanup doesn't try to
      // kill an already-exited PID (and so it doesn't reach for the bridge
      // port, which the spawned child may now own on a different port).
      harness.process = null;
    } finally {
      await harness?.stop().catch(() => undefined);
      await api?.close().catch(() => undefined);
      await fs
        .rm(tempRoot, { recursive: true, force: true })
        .catch(() => undefined);
    }
  });

  // KNOWN GAP: a "execPath points at a non-existent binary" regression test
  // would require an env override on the packaged shell to force
  // `process.execPath` (or the launcher's `argv[0]`) to a bad value. No such
  // override exists today — `DesktopManager.relaunch()` reads `process.execPath`
  // directly with no indirection. Adding the override is non-trivial because
  // Electrobun's launcher controls argv before Bun starts. Until that hook
  // exists, the regression must be covered at the unit level by mocking
  // `Bun.spawn` in a future native/desktop.test.ts. Tracked under item 13 of
  // `docs/QA-onboarding-followups.md`.
});

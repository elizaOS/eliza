// Real on-device CODING e2e: drive the actual app's WebView to make the
// on-device agent CREATE a file, then assert the file landed on the device
// filesystem via `adb run-as` — a true before/after workspace diff.
//
// Unlike the browser ui-smoke suite (desktop Chromium + mocked /api), this lane
// runs against the ACTUAL app installed on a device/emulator and the REAL
// on-device agent (loopback :31337). It exercises the coding-tools FILE write
// path that only exists when the build runs with ELIZA_RUNTIME_MODE=local-yolo
// (see plugins/plugin-coding-tools/auto-enable.ts) on a privileged AOSP/arm64
// device — a stock x86_64 emulator can't run the embedded agent (README.md).
//
// CLEAN-SKIP: on a bare CI box (no adb, no device, no debuggable WebView) the
// top-level guard test.skip()s and the process exits 0. The deterministic
// "no-op" cases below (payload + workspace-path + gating builders) ALWAYS run so
// the file is not a pure no-op even with no device attached.
//
// Run live:  bun run --cwd packages/app test:e2e:android:webview
//   (requires: Android SDK adb/emulator resolvable; a privileged arm64 device
//    or branded AOSP image with the on-device agent up + healthy at :31337 with
//    coding tools enabled via ELIZA_RUNTIME_MODE=local-yolo, pairing disabled
//    via ELIZA_PAIRING_DISABLED=1, and a WebView-debuggable APK built with
//    ELIZA_WEBVIEW_DEBUG=1.)
import { spawn } from "node:child_process";
import * as path from "node:path";
import type { AndroidDevice } from "@playwright/test";
import {
  AGENT_API_PORT,
  APP_ID,
  adbTry,
  connectPlaywrightDevice,
  listDevices,
  resolveAdb,
} from "../../scripts/lib/android-device.mjs";
import { android, expect, test, waitForShellReady } from "./android-harness";

// ---------------------------------------------------------------------------
// Deterministic builders (run on every box, even with no device) — these are
// the parts that don't need hardware, asserted for real below.
// ---------------------------------------------------------------------------

/** Per-run unique marker so the before/after diff can't collide with stale state. */
function makeNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The file the coding task is asked to create, plus its known marker content. */
function buildCodingTarget(nonce: string): {
  fileName: string;
  marker: string;
} {
  return {
    fileName: `eliza-coding-e2e-${nonce}.txt`,
    marker: `eliza-android-coding-ok:${nonce}`,
  };
}

/**
 * The app-private workspace path adb `run-as` can read. The on-device session
 * cwd defaults to the agent process cwd (SessionCwdService.defaultCwd ->
 * path.resolve(process.cwd())); inside the debuggable app sandbox that maps to
 * /data/data/<APP_ID>/files. run-as can only read app-private files for a
 * debuggable package, so we assert relative to the package's files/ dir.
 */
function deviceWorkspaceRelPath(fileName: string, subdir: string): string {
  // posix join — this is a device (Linux) path, not the host's.
  return path.posix.join("files", subdir, fileName);
}

/**
 * Mirror of plugins/plugin-coding-tools/auto-enable.ts terminalSupportedByEnv:
 * on Android the FILE coding path only exists when runtime mode is local-yolo
 * and the build variant is not "store". This lets the spec distinguish
 * "feature gated off" (loud fail) from "no device" (skip) without importing the
 * plugin's runtime.
 */
function androidCodingPathEnabled(env: {
  variant?: string;
  mode?: string;
}): boolean {
  if ((env.variant ?? "").trim().toLowerCase() === "store") return false;
  return (env.mode ?? "").trim().toLowerCase() === "local-yolo";
}

test.describe("android coding workspace diff: deterministic payload builders", () => {
  test("nonce is unique and the target/marker carry it", () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).not.toBe(b);
    const target = buildCodingTarget(a);
    expect(target.fileName).toContain(a);
    expect(target.fileName.endsWith(".txt")).toBe(true);
    expect(target.marker).toBe(`eliza-android-coding-ok:${a}`);
    // The marker is a stable, exact string we can byte-compare against `cat`.
    expect(target.marker).toMatch(/^eliza-android-coding-ok:[a-z0-9-]+$/);
  });

  test("device workspace path stays under the run-as-readable files/ sandbox", () => {
    const { fileName } = buildCodingTarget("nonce0");
    const rel = deviceWorkspaceRelPath(fileName, "workspace");
    expect(rel).toBe("files/workspace/eliza-coding-e2e-nonce0.txt");
    expect(rel.startsWith("files/")).toBe(true);
    // Never escapes the sandbox the assertion path can read.
    expect(rel.includes("..")).toBe(false);
  });

  test("Android coding FILE path gates exactly on local-yolo + non-store (mirrors auto-enable.ts)", () => {
    expect(androidCodingPathEnabled({ mode: "local-yolo" })).toBe(true);
    expect(
      androidCodingPathEnabled({ mode: "local-yolo", variant: "dev" }),
    ).toBe(true);
    // Gated OFF on the store variant and on any non-yolo mode.
    expect(
      androidCodingPathEnabled({ mode: "local-yolo", variant: "store" }),
    ).toBe(false);
    expect(androidCodingPathEnabled({ mode: "remote" })).toBe(false);
    expect(androidCodingPathEnabled({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Live on-device coding e2e — device-gated, clean-skips on a bare CI box.
// ---------------------------------------------------------------------------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolve adb or null (no throw) so the skip guard stays quiet on a bare box. */
function tryResolveAdb(): string | null {
  try {
    return resolveAdb();
  } catch {
    return null;
  }
}

type LiveProbe = {
  ok: boolean;
  reason: string;
  adb: string;
  serial: string;
  device: AndroidDevice | null;
};

/**
 * Clean-skip probe: adb resolvable AND >=1 device in `device` state AND a
 * Playwright Android device can attach. Returns ok:false (with a reason) when
 * any precondition is missing — the caller test.skip()s on that.
 */
async function probeLiveDevice(): Promise<LiveProbe> {
  const adb = tryResolveAdb();
  if (!adb) {
    return {
      ok: false,
      reason:
        "adb not found (no Android SDK / ANDROID_HOME / ANDROID_SDK_ROOT / ADB)",
      adb: "",
      serial: "",
      device: null,
    };
  }
  const serials = listDevices(adb);
  if (serials.length === 0) {
    return {
      ok: false,
      reason: "no Android device/emulator in `device` state",
      adb,
      serial: "",
      device: null,
    };
  }
  let device: AndroidDevice | null = null;
  try {
    device = await connectPlaywrightDevice(android, process.env.ANDROID_SERIAL);
  } catch (error) {
    return {
      ok: false,
      reason: `Playwright Android driver could not attach: ${
        error instanceof Error ? error.message : String(error)
      }`,
      adb,
      serial: serials[0],
      device: null,
    };
  }
  if (!device) {
    return {
      ok: false,
      reason: "Playwright Android driver returned no device",
      adb,
      serial: serials[0],
      device: null,
    };
  }
  return { ok: true, reason: "", adb, serial: device.serial(), device };
}

/** Read agent health through the WebView's own fetch (real loopback path). */
async function probeAgentHealth(
  page: import("@playwright/test").Page,
): Promise<{
  status: number;
  body: string;
}> {
  return page.evaluate(async (port: number) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        headers: { "X-ElizaOS-Client-Id": "android-coding-e2e" },
      });
      return { status: res.status, body: await res.text() };
    } catch (error) {
      return { status: 0, body: String(error) };
    }
  }, AGENT_API_PORT);
}

test.describe
  .serial("android coding workspace diff (real on-device agent)", () => {
    const nonce = makeNonce();
    const { fileName, marker } = buildCodingTarget(nonce);
    // The on-device coding write request: a chat-style instruction is the
    // realistic driver, but the exact endpoint differs by build, so allow an
    // env override. The default posts a message to the agent asking it to write
    // the file under the session cwd. The deterministic local-runner fallback
    // can be wired by overriding ELIZA_ANDROID_CODING_ENDPOINT.
    const codingEndpoint =
      process.env.ELIZA_ANDROID_CODING_ENDPOINT?.trim() || "";
    const workspaceSubdir = process.env.ELIZA_ANDROID_WORKSPACE_SUBDIR ?? "";
    const deviceRelPath = deviceWorkspaceRelPath(
      fileName,
      workspaceSubdir || "workspace",
    );

    let probe: LiveProbe;
    let screenrecord: ReturnType<typeof spawn> | null = null;
    const remoteRecordPath = "/sdcard/eliza-coding-e2e.mp4";

    test.beforeAll(async () => {
      probe = await probeLiveDevice();
      if (!probe.ok) {
        console.warn(
          `[android-coding-e2e] SKIP — ${probe.reason}. On-device coding e2e ` +
            "requires a staged Android device/emulator with the on-device agent. " +
            "Run live: bun run --cwd packages/app test:e2e:android:webview",
        );
        test.skip(true, `no live Android device: ${probe.reason}`);
        return;
      }
      // Capture a screenrecord of the whole run (best-effort; pulled in afterAll).
      // Spawn detached so it survives the test body; capped to the lane budget.
      try {
        screenrecord = spawn(
          probe.adb,
          [
            "-s",
            probe.serial,
            "shell",
            "screenrecord",
            "--time-limit",
            "180",
            remoteRecordPath,
          ],
          { stdio: "ignore" },
        );
      } catch {
        screenrecord = null;
      }
    });

    test.afterAll(async () => {
      // Stop the recording and pull it; best-effort, never fails the suite.
      if (screenrecord && !screenrecord.killed) {
        try {
          screenrecord.kill("SIGINT");
        } catch {
          /* ignore */
        }
        await delay(2_000);
      }
      if (probe?.ok && probe.serial) {
        const out = test.info().outputPath("eliza-coding-e2e.mp4");
        try {
          adbTry(probe.adb, [
            "-s",
            probe.serial,
            "pull",
            remoteRecordPath,
            out,
          ]);
          await test
            .info()
            .attach("screenrecord", { path: out, contentType: "video/mp4" })
            .catch(() => {});
        } catch {
          /* ignore */
        }
        adbTry(probe.adb, [
          "-s",
          probe.serial,
          "shell",
          "rm",
          "-f",
          remoteRecordPath,
        ]);
      }
      if (probe?.device) {
        // The worker `device` fixture also closes its own handle; closing this
        // extra probe handle is best-effort and idempotent.
        await probe.device.close().catch(() => {});
      }
    });

    test("on-device coding task creates a file, asserted via adb workspace diff", async ({
      page,
    }) => {
      // PRECONDITION: shell past the connecting splash and a real agent at :31337.
      await waitForShellReady(page);
      let health = await probeAgentHealth(page);
      await expect
        .poll(
          async () => {
            health = await probeAgentHealth(page);
            return health.status;
          },
          {
            timeout: 60_000,
            intervals: [500, 1000, 2000],
            message: "on-device agent never answered /api/health with 200",
          },
        )
        .toBe(200);
      expect(health.status, `health body: ${health.body}`).toBe(200);

      const { adb, serial } = probe;

      // run-as can only read app-private files for a debuggable package; if the
      // package isn't debuggable, run-as fails — that means the wrong (store/
      // release) APK is installed, which gates the coding path off entirely.
      const runAsProbe = adbTry(adb, [
        "-s",
        serial,
        "shell",
        "run-as",
        APP_ID,
        "id",
      ]);
      if (
        !runAsProbe ||
        /run-as:|not debuggable|unknown package/i.test(runAsProbe)
      ) {
        const logcat = adbTry(adb, ["-s", serial, "logcat", "-d", "-t", "120"]);
        throw new Error(
          `[android-coding-e2e] adb run-as ${APP_ID} failed (package not debuggable?). ` +
            "The on-device coding write path needs a debug, local-yolo build " +
            "(ELIZA_WEBVIEW_DEBUG=1, ELIZA_RUNTIME_MODE=local-yolo). " +
            `run-as output: ${runAsProbe || "<empty>"}\nLogcat tail:\n${logcat.slice(-2000)}`,
        );
      }

      // BEFORE-STATE: the nonce file must NOT yet exist under the workspace.
      const beforeCat = adbTry(adb, [
        "-s",
        serial,
        "shell",
        "run-as",
        APP_ID,
        "cat",
        deviceRelPath,
      ]);
      expect(
        beforeCat.includes(marker),
        `target ${deviceRelPath} already contained the marker before the task ran`,
      ).toBe(false);
      const beforeLs = adbTry(adb, [
        "-s",
        serial,
        "shell",
        "run-as",
        APP_ID,
        "ls",
        "-1",
        path.posix.dirname(deviceRelPath),
      ]);

      // ACTION: drive the on-device agent (from the WebView's own fetch) to
      // create the file. The endpoint shape is build-specific, so it must be
      // supplied via env for the live lane; without it we cannot assert a REAL
      // write, so fail loudly rather than silently pass.
      if (!codingEndpoint) {
        const logcat = adbTry(adb, ["-s", serial, "logcat", "-d", "-t", "80"]);
        throw new Error(
          "[android-coding-e2e] device present + agent healthy, but no coding " +
            "driver configured. Set ELIZA_ANDROID_CODING_ENDPOINT to the agent " +
            "path that triggers the FILE write (a coding/TASKS spawn or the " +
            "deterministic local-runner), and ELIZA_ANDROID_WORKSPACE_SUBDIR to " +
            "the session-cwd subdir under files/. This is a feature-present/ " +
            "driver-absent condition — NOT 'no device' — so it fails loudly.\n" +
            `Logcat tail:\n${logcat.slice(-1500)}`,
        );
      }

      const writeResult = await page.evaluate(
        async (args: {
          port: number;
          endpoint: string;
          relPath: string;
          content: string;
        }) => {
          try {
            const url = args.endpoint.startsWith("http")
              ? args.endpoint
              : `http://127.0.0.1:${args.port}${args.endpoint}`;
            const res = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-ElizaOS-Client-Id": "android-coding-e2e",
              },
              body: JSON.stringify({
                // FILE action shape (action=write, target=device) so the agent's
                // device-filesystem bridge writes under its files/ sandbox.
                action: "FILE",
                file_path: args.relPath,
                path: args.relPath,
                target: "device",
                content: args.content,
                // Free-form text drivers (chat/TASKS) read this instead.
                text: `Use the FILE write action to create ${args.relPath} with exactly this content: ${args.content}`,
              }),
            });
            return { status: res.status, body: await res.text() };
          } catch (error) {
            return { status: 0, body: String(error) };
          }
        },
        {
          port: AGENT_API_PORT,
          endpoint: codingEndpoint,
          relPath: deviceRelPath,
          content: marker,
        },
      );
      expect(
        writeResult.status >= 200 && writeResult.status < 500,
        `coding endpoint POST ${codingEndpoint} returned ${writeResult.status}: ${writeResult.body.slice(0, 400)}`,
      ).toBeTruthy();

      // AFTER-STATE: poll the workspace until the marker appears (the task may be
      // async). Fail loudly within the lane budget if it never lands.
      let afterCat = "";
      await expect
        .poll(
          () => {
            afterCat = adbTry(adb, [
              "-s",
              serial,
              "shell",
              "run-as",
              APP_ID,
              "cat",
              deviceRelPath,
            ]);
            return afterCat.includes(marker);
          },
          {
            timeout: 120_000,
            intervals: [1000, 2000, 5000],
            message: `coding task never wrote ${deviceRelPath} with the marker`,
          },
        )
        .toBe(true);

      // Exact content match — the file holds precisely the known marker.
      expect(afterCat.trim()).toBe(marker);

      // WORKSPACE DIFF: exactly one new entry (the nonce file) appeared.
      const afterLs = adbTry(adb, [
        "-s",
        serial,
        "shell",
        "run-as",
        APP_ID,
        "ls",
        "-1",
        path.posix.dirname(deviceRelPath),
      ]);
      const beforeSet = new Set<string>(
        String(beforeLs)
          .split(/\r?\n/)
          .map((l: string) => l.trim())
          .filter(Boolean),
      );
      const added = String(afterLs)
        .split(/\r?\n/)
        .map((l: string) => l.trim())
        .filter((l: string) => l && !beforeSet.has(l));
      expect(
        added,
        `workspace diff should add exactly [${fileName}], got [${added.join(", ")}]`,
      ).toEqual([fileName]);

      // Attach the before/after listing as evidence.
      await test
        .info()
        .attach("workspace-diff", {
          body: `BEFORE:\n${beforeLs}\n\nAFTER:\n${afterLs}\n\nADDED:\n${added.join("\n")}`,
          contentType: "text/plain",
        })
        .catch(() => {});

      // Clean up the created file so reruns start clean.
      adbTry(adb, [
        "-s",
        serial,
        "shell",
        "run-as",
        APP_ID,
        "rm",
        "-f",
        deviceRelPath,
      ]);
    });
  });

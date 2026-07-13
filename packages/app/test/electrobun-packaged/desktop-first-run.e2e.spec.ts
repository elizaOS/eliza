/**
 * Packaged Electrobun first-run + pairing coverage (#13683).
 *
 * The packaged desktop lane used to boot every spec with `firstRunComplete:true`,
 * which skipped the two startup paths most likely to diverge in the real shell:
 * chat-first onboarding and remote pairing. These tests drive both through the
 * desktop bridge `eval` seam against the packaged app.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { startLiveApiServer, type TestApiServer } from "./live-api";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

const RUNTIME_CHOICE = (id: "cloud" | "local" | "remote") =>
  `choice-__first_run__:runtime:${id}`;
const PROVIDER_CHOICE = (id: "on-device" | "elizacloud" | "other") =>
  `choice-__first_run__:provider:${id}`;
const AUTOSTART_CHOICE = (id: "enable" | "skip") =>
  `choice-__first_run__:autostart:${id}`;
const TUTORIAL_CHOICE = (id: "start" | "skip") =>
  `choice-__first_run__:tutorial:${id}`;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cssString(value: string): string {
  return JSON.stringify(value);
}

async function bridgeEval<T>(
  harness: PackagedDesktopHarness,
  script: string,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await harness.eval<T>(script);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out after|main-window\/eval failed \(500\)/.test(message)) {
        throw error;
      }
      lastError = error;
      await delay(500);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function waitForDom(
  harness: PackagedDesktopHarness,
  predicateScript: string,
  options: { message: string; timeoutMs?: number },
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  let last: unknown;
  while (Date.now() < deadline) {
    last = await bridgeEval<unknown>(harness, predicateScript);
    if (last === true) return;
    await delay(500);
  }
  throw new Error(`${options.message}. Last result: ${JSON.stringify(last)}`);
}

async function clickTestId(
  harness: PackagedDesktopHarness,
  testId: string,
): Promise<void> {
  const result = await bridgeEval<EvalResult<{ clicked: boolean }>>(
    harness,
    `(() => {
      try {
        const el = document.querySelector('[data-testid=${cssString(testId)}]');
        if (!(el instanceof HTMLElement)) {
          return { ok: false, error: ${cssString(`missing test id ${testId}`)} };
        }
        el.scrollIntoView({ block: "center", inline: "center" });
        el.click();
        return { ok: true, clicked: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!result.ok) {
    throw new Error(`clickTestId(${testId}) failed: ${result.error}`);
  }
}

async function waitForTestId(
  harness: PackagedDesktopHarness,
  testId: string,
  timeoutMs = 60_000,
): Promise<void> {
  await waitForDom(
    harness,
    `Boolean(document.querySelector('[data-testid=${cssString(testId)}]'))`,
    { message: `Expected [data-testid=${testId}]`, timeoutMs },
  );
}

async function waitForRestingShell(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await waitForDom(
    harness,
    `(() => {
      const startupShell = document.querySelector('[data-testid="startup-shell-loading"]');
      const firstRunBackdrop = document.querySelector('[data-testid="chat-first-run-backdrop"]');
      const composer = document.querySelector('[data-testid="chat-composer-textarea"]');
      const home =
        document.querySelector('[data-testid="home-launcher-surface"]') ||
        document.querySelector('[data-testid="shell-home-pill"]');
      return Boolean(!startupShell && !firstRunBackdrop && composer && home);
    })()`,
    {
      message: "Expected packaged desktop to land on the resting shell",
      timeoutMs: process.env.CI ? 120_000 : 60_000,
    },
  );
}

/**
 * Fire a renderer-bridge RPC (window.__ELIZA_ELECTROBUN_RPC__) from the
 * packaged renderer and await its settlement. The eval seam evaluates a
 * synchronous Function body, so the async call is kicked off into a window
 * global and polled — never relying on promise-return semantics of eval.
 */
async function bridgeRpc<T>(
  harness: PackagedDesktopHarness,
  rpcMethod: string,
  params: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const slot = `__eliza_e2e_rpc_${rpcMethod}_${Date.now()}`;
  const kicked = await bridgeEval<EvalResult<{ started: boolean }>>(
    harness,
    `(() => {
      try {
        const rpc = window.__ELIZA_ELECTROBUN_RPC__;
        const request = rpc && rpc.request && rpc.request[${cssString(rpcMethod)}];
        if (typeof request !== "function") {
          return { ok: false, error: ${cssString(`renderer bridge missing ${rpcMethod}`)} };
        }
        window[${cssString(slot)}] = { pending: true };
        Promise.resolve(request.call(rpc.request, ${JSON.stringify(params ?? null)})).then(
          (value) => {
            window[${cssString(slot)}] = { pending: false, value: value === undefined ? null : value };
          },
          (e) => {
            window[${cssString(slot)}] = { pending: false, error: e instanceof Error ? e.message : String(e) };
          },
        );
        return { ok: true, started: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`,
  );
  if (!kicked.ok) {
    throw new Error(`bridgeRpc(${rpcMethod}) failed to start: ${kicked.error}`);
  }
  await waitForDom(
    harness,
    `(() => {
      const probe = window[${cssString(slot)}];
      return Boolean(probe && probe.pending === false);
    })()`,
    { message: `Expected ${rpcMethod} to settle`, timeoutMs },
  );
  const settled = await bridgeEval<{
    pending: boolean;
    value?: T;
    error?: string;
  }>(
    harness,
    `(() => { const probe = window[${cssString(slot)}]; delete window[${cssString(slot)}]; return probe; })()`,
  );
  if (settled.error !== undefined) {
    throw new Error(`bridgeRpc(${rpcMethod}) rejected: ${settled.error}`);
  }
  return settled.value as T;
}

/**
 * The packaged app runs with the REAL user HOME, so the auto-launch artifact
 * the onboarding Enable pick writes is the developer's actual login item
 * (macOS LaunchAgent plist / Linux autostart .desktop — same brand names as
 * production). Snapshot any pre-existing artifact before the test and restore
 * it afterwards so a dev machine's own auto-launch setup is never clobbered,
 * and a test-written artifact (pointing at the throwaway packaged binary) is
 * never left behind. Windows has no artifact reachable from this process; the
 * in-app bridge disable in the test body is the cleanup there.
 */
function autoLaunchArtifactPath(): string | null {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "LaunchAgents",
      "ai.elizaos.app.plist",
    );
  }
  if (process.platform === "linux") {
    return path.join(os.homedir(), ".config", "autostart", "elizaos.desktop");
  }
  return null;
}

async function snapshotAutoLaunchArtifact(): Promise<string | null> {
  const artifact = autoLaunchArtifactPath();
  if (!artifact) return null;
  return await fs.readFile(artifact, "utf8").catch(() => null);
}

async function restoreAutoLaunchArtifact(
  preExisting: string | null,
): Promise<void> {
  const artifact = autoLaunchArtifactPath();
  if (!artifact) return;
  if (preExisting === null) {
    await fs.rm(artifact, { force: true }).catch(() => undefined);
    return;
  }
  await fs.mkdir(path.dirname(artifact), { recursive: true });
  await fs.writeFile(artifact, preExisting, "utf8");
}

async function launchHarness(args: {
  tempPrefix: string;
  apiBase: string;
}): Promise<{ tempRoot: string; harness: PackagedDesktopHarness }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), args.tempPrefix));
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  );
  expect(
    launcherPath,
    "Packaged Electrobun launcher is required (run the desktop build first).",
  ).toBeTruthy();

  const harness = new PackagedDesktopHarness({
    tempRoot,
    launcherPath: launcherPath as string,
    apiBase: args.apiBase,
    extraEnv: {
      ELIZA_DESKTOP_TEST_ENABLE_RUNTIME_CHOOSER: "1",
      // The packaged default main window is the chromeless bottom-bar pill
      // (shouldStartBottomBar), whose chat-overlay shell never renders the
      // full-window surfaces this spec drives (onboarding CHOICE widgets, the
      // pairing gate). Opt out to boot the classic full dashboard window —
      // the same pattern electrobun-packaged-regressions.e2e.spec.ts uses.
      ELIZA_DESKTOP_BOTTOM_BAR: "0",
    },
  });

  await harness.start({
    bridgeHealthTimeoutMs: 300_000,
    shellReadyTimeoutMs: process.env.CI ? 120_000 : 90_000,
  });
  await harness.showMainWindow();
  await harness.focusMainWindow();
  return { tempRoot, harness };
}

/**
 * Re-boot the renderer through its own `?reset` escape hatch
 * (first-run-boot-patches): clears the persisted active-server / setup-step /
 * first-run-complete records and arms a genuinely fresh first run.
 *
 * Needed because the packaged macOS main view is never partition-isolated
 * (shouldUseIsolatedMainView is Windows/CEF-only), so WebKit localStorage is
 * machine-global across packaged runs — any earlier run that completed
 * onboarding leaves `eliza:first-run-complete=1` + a stale
 * `elizaos:active-server` behind, and the conductor never activates.
 */
async function rebootIntoFreshFirstRun(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await bridgeEval<boolean>(
    harness,
    `(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("reset", "1");
      url.searchParams.set("enableRuntimeChooser", "1");
      window.location.replace(url.toString());
      return true;
    })()`,
  );
}

/**
 * Drop a stale persisted active-server record (same machine-global-storage
 * problem as above) and reload, WITHOUT resetting first-run: the pairing spec
 * runs against a mock API that reports first-run complete, and a leftover
 * record from an earlier packaged run otherwise routes the app away from the
 * injected mock API and the pairing gate never renders.
 */
async function rebootWithoutStaleActiveServer(
  harness: PackagedDesktopHarness,
): Promise<void> {
  await bridgeEval<boolean>(
    harness,
    `(() => {
      try {
        window.localStorage.removeItem("elizaos:active-server");
      } catch (e) { void e; }
      window.location.reload();
      return true;
    })()`,
  );
}

/**
 * Settle on whichever surface boots first: the pairing gate or the normal
 * shell. Used by the retry loop below — a booting app can re-persist the
 * active-server record around a single remove+reload (write-back race), so
 * the pairing test settles, then reboots clean until the gate wins.
 */
async function waitForPairingOrShell(
  harness: PackagedDesktopHarness,
  timeoutMs: number,
): Promise<"pairing" | "shell" | "unknown"> {
  const deadline = Date.now() + timeoutMs;
  let last: "pairing" | "shell" | "unknown" = "unknown";
  while (Date.now() < deadline) {
    last = await bridgeEval<"pairing" | "shell" | "unknown">(
      harness,
      `(() => {
        if (document.body.innerText.includes("Pairing Required")) return "pairing";
        if (
          document.querySelector('[data-testid="chat-composer-textarea"]') ||
          document.querySelector('[data-testid="home-launcher-surface"]')
        ) {
          return "shell";
        }
        return "unknown";
      })()`,
    );
    if (last === "pairing" || last === "shell") return last;
    await delay(500);
  }
  return last;
}

test("packaged desktop drives chat-first onboarding (with auto-start enable) and persists first-run", async () => {
  test.setTimeout(600_000);

  let api: TestApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  const preExistingAutoLaunch = await snapshotAutoLaunchArtifact();
  try {
    api = await startLiveApiServer({ firstRunComplete: false, port: 0 });
    ({ harness } = await launchHarness({
      tempPrefix: "eliza-desktop-first-run-",
      apiBase: api.baseUrl,
    }));
    await rebootIntoFreshFirstRun(harness);

    await waitForTestId(harness, RUNTIME_CHOICE("local"), 120_000);
    // Partition storage can persist across packaged runs on a dev machine —
    // clear the priming shown-once flag so the post-onboarding eligibility
    // assertion below is deterministic.
    await bridgeEval<boolean>(
      harness,
      `(() => {
        try { window.localStorage.removeItem("eliza:permissions-primed"); } catch {}
        return true;
      })()`,
    );
    await clickTestId(harness, RUNTIME_CHOICE("local"));
    await waitForTestId(harness, PROVIDER_CHOICE("on-device"));
    await clickTestId(harness, PROVIDER_CHOICE("on-device"));

    // Wrap-up: the desktop shell offers the auto-start choice between the
    // provider finish and the tutorial. Enable it, then prove the real OS
    // artifact through the same bridge RPC the Settings toggle reads.
    await waitForTestId(harness, AUTOSTART_CHOICE("enable"));
    await clickTestId(harness, AUTOSTART_CHOICE("enable"));
    await expect
      .poll(
        async () =>
          bridgeRpc<{ enabled: boolean; openAsHidden: boolean }>(
            // biome-ignore lint/style/noNonNullAssertion: assigned above
            harness!,
            "desktopGetAutoLaunchStatus",
            null,
          ),
        {
          message:
            "desktopGetAutoLaunchStatus should report enabled after the onboarding Enable pick",
          timeout: 30_000,
        },
      )
      .toEqual({ enabled: true, openAsHidden: false });

    await waitForTestId(harness, TUTORIAL_CHOICE("skip"));
    await clickTestId(harness, TUTORIAL_CHOICE("skip"));

    await waitForRestingShell(harness);
    expect(
      api.requests.filter((request) => request === "POST /api/first-run"),
      "packaged onboarding should persist first-run exactly once",
    ).toHaveLength(1);

    // After onboarding completes (firstRunComplete flipped, tutorial skipped),
    // the post-onboarding permission-priming sequence becomes eligible: its
    // overlay mounts, and completing it flips the durable shown-once flag.
    // If every permission already reads satisfied the modal auto-completes,
    // so accept either observable (modal on screen, or flag already flipped).
    await waitForDom(
      harness,
      `(() => {
        try {
          if (window.localStorage.getItem("eliza:permissions-primed") === "1") return true;
        } catch {}
        return Boolean(document.querySelector('[data-testid="permission-priming-modal"]'));
      })()`,
      {
        message:
          "Expected the permission-priming sequence to become eligible after onboarding",
        timeoutMs: 120_000,
      },
    );
    // Finish the sequence via the whole-flow skip when cards are promptable
    // (idempotent — re-clicks are no-ops once the flag flips); the flag is the
    // durable completion observable either way.
    await waitForDom(
      harness,
      `(() => {
        try {
          if (window.localStorage.getItem("eliza:permissions-primed") === "1") return true;
        } catch {}
        const skip = document.querySelector('[data-testid="priming-skip-all"]');
        if (skip instanceof HTMLElement) skip.click();
        try {
          return window.localStorage.getItem("eliza:permissions-primed") === "1";
        } catch { return false; }
      })()`,
      {
        message:
          "Expected the permission-priming sequence to complete and persist its shown-once flag",
        timeoutMs: 60_000,
      },
    );

    // Clean up the login item while the app is still alive: the packaged app
    // runs against the REAL user HOME, so a LaunchAgent pointing at this
    // throwaway test binary must not survive the test.
    await bridgeRpc<null>(harness, "desktopSetAutoLaunch", {
      enabled: false,
      openAsHidden: false,
    });
    await expect
      .poll(
        async () =>
          bridgeRpc<{ enabled: boolean; openAsHidden: boolean }>(
            // biome-ignore lint/style/noNonNullAssertion: assigned above
            harness!,
            "desktopGetAutoLaunchStatus",
            null,
          ),
        {
          message: "auto-launch should be disabled again after cleanup",
          timeout: 30_000,
        },
      )
      .toEqual({ enabled: false, openAsHidden: false });
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
    // Belt-and-suspenders: restore whatever auto-launch artifact existed
    // before the test (or remove a leftover test-written one) even when the
    // in-app disable above never ran because the test failed earlier.
    await restoreAutoLaunchArtifact(preExistingAutoLaunch).catch(
      () => undefined,
    );
  }
});

test("packaged desktop pairing auth redeems a code and reaches auth/me", async () => {
  test.setTimeout(600_000);

  const pairedToken = "packaged-paired-token";
  const pairingCode = "ABCD EFGH IJKL";
  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    api = await startMockApiServer({
      firstRunComplete: true,
      port: 0,
      auth: {
        token: pairedToken,
        pairingCode,
        pairingEnabled: true,
      },
    });
    ({ harness } = await launchHarness({
      tempPrefix: "eliza-desktop-pairing-",
      apiBase: api.baseUrl,
    }));

    // Machine-global WebKit storage can carry an active-server record from an
    // earlier packaged run (including the onboarding test above), which routes
    // the app away from the injected mock API. Settle, then reboot without the
    // record until the pairing gate wins — a single remove+reload can lose a
    // write-back race against the booting app's persistence layer.
    let gate = await waitForPairingOrShell(harness, 120_000);
    for (let attempt = 0; gate !== "pairing" && attempt < 3; attempt += 1) {
      await rebootWithoutStaleActiveServer(harness);
      gate = await waitForPairingOrShell(harness, 60_000);
    }
    expect(gate, "Expected packaged desktop pairing screen").toBe("pairing");

    const pairResult = await bridgeEval<EvalResult<{ submitted: boolean }>>(
      harness,
      `(() => {
        try {
          const input = Array.from(document.querySelectorAll("input, textarea"))
            .find((el) => /pairing code/i.test(el.getAttribute("placeholder") || ""));
          if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) {
            return { ok: false, error: "pairing input not found" };
          }
          input.focus();
          // React's controlled Input tracks the last value it set; a direct
          // \`input.value = ...\` assignment is invisible to its change
          // detection, so the store would submit an empty code. Write through
          // the native prototype setter, then dispatch input.
          const proto = input instanceof HTMLInputElement
            ? window.HTMLInputElement.prototype
            : window.HTMLTextAreaElement.prototype;
          const valueSetter = Object.getOwnPropertyDescriptor(proto, "value");
          if (valueSetter && valueSetter.set) {
            valueSetter.set.call(input, ${cssString(pairingCode)});
          } else {
            input.value = ${cssString(pairingCode)};
          }
          input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ${cssString(pairingCode)} }));
          const button = Array.from(document.querySelectorAll("button"))
            .find((el) => /submit|pair|activate/i.test(el.textContent || ""));
          if (!(button instanceof HTMLButtonElement)) {
            return { ok: false, error: "pairing submit button not found" };
          }
          button.click();
          return { ok: true, submitted: true };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      })()`,
    );
    if (!pairResult.ok) {
      throw new Error(`pairing submit failed: ${pairResult.error}`);
    }

    await waitForDom(
      harness,
      `!document.body.innerText.includes("Pairing Required")`,
      {
        message: "Expected pairing screen to disappear after redeeming code",
        timeoutMs: 60_000,
      },
    );
    await waitForRestingShell(harness);

    const storedToken = await bridgeEval<string | null>(
      harness,
      `(() => {
        const raw = window.localStorage.getItem("elizaos:active-server");
        if (!raw) return null;
        try {
          return JSON.parse(raw).accessToken ?? null;
        } catch {
          return null;
        }
      })()`,
    );
    expect(storedToken).toBe(pairedToken);
    expect(api.requests).toContain("POST /api/auth/pair");
    expect(api.requests).toContain("GET /api/auth/me");
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});

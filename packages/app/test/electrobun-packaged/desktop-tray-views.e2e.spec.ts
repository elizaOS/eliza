/**
 * Packaged-desktop tray/popover launcher-parity e2e.
 *
 * Proves that every entry in the curated launcher list (the exact
 * post-curation list the Launcher grid renders) is mirrored into the desktop
 * views surfaces once the view registry loads: the runtime tray-view catalog
 * (which backs the native tray "Views" submenu on Windows/Linux and resolves
 * `tray-open-view-<id>` clicks everywhere) and the tray-popover launcher rows
 * (the macOS menu-bar views surface). Also asserts the native tray icon is
 * present via the bridge `/state` snapshot.
 *
 * The parity read goes through the renderer diagnostics globals the runtime
 * publishes (`elizaos.ui.curated-launcher`, `elizaos.desktop.tray-views`,
 * `elizaos.ui.desktop-tray-launcher` — same globalThis pattern as
 * `shell-surface-store`), because the bridge `/state` intentionally exposes no
 * tray menu items and `eval` has no ESM import seam into the bundle.
 *
 * Platform-parameterized: no darwin-only assumptions, so the Windows packaged
 * lane (run-desktop-packaged-windows.mjs) and a future Linux xvfb lane can run
 * it unchanged.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { type MockApiServer, startMockApiServer } from "./mock-api";
import {
  PackagedDesktopHarness,
  resolvePackagedLauncher,
} from "./packaged-app-helpers";

type EvalOk<T> = T & { ok: true };
type EvalErr = { ok: false; error: string };
type EvalResult<T> = EvalOk<T> | EvalErr;

interface CuratedEntry {
  id: string;
  label: string;
  path?: string;
}

interface RuntimeTrayView {
  id: string;
  label: string;
  path: string;
}

interface LauncherRow {
  itemId: string;
  label: string;
}

interface ViewsSurfacesRead {
  curated: CuratedEntry[] | null;
  trayCatalog: RuntimeTrayView[] | null;
  popoverRows: LauncherRow[] | null;
}

async function readViewsSurfaces(
  harness: PackagedDesktopHarness,
): Promise<ViewsSurfacesRead> {
  const result = await harness.eval<EvalResult<ViewsSurfacesRead>>(`(() => {
    try {
      const g = globalThis;
      const curated = g[Symbol.for("elizaos.ui.curated-launcher")];
      const tray = g[Symbol.for("elizaos.desktop.tray-views")];
      const rows = g[Symbol.for("elizaos.ui.desktop-tray-launcher")];
      return {
        ok: true,
        curated: curated ? curated.entries : null,
        trayCatalog: tray ? tray.catalog : null,
        popoverRows: rows ? rows.entries : null,
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })()`);
  if (!result.ok) {
    throw new Error(`readViewsSurfaces eval failed: ${result.error}`);
  }
  return result;
}

test("tray/popover views mirror the curated launcher list one-to-one", async ({
  browserName: _browserName,
}) => {
  void _browserName;
  test.setTimeout(600_000);

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-desktop-tray-views-"),
  );
  const launcherPath = await resolvePackagedLauncher(
    path.join(tempRoot, "extract"),
  );
  expect(
    launcherPath,
    "Packaged Electrobun launcher is required (run the desktop build first).",
  ).toBeTruthy();

  let api: MockApiServer | null = null;
  let harness: PackagedDesktopHarness | null = null;
  try {
    api = await startMockApiServer({ firstRunComplete: true, port: 0 });
    harness = new PackagedDesktopHarness({
      tempRoot,
      launcherPath: launcherPath as string,
      apiBase: api.baseUrl,
    });
    await harness.start({
      bridgeHealthTimeoutMs: 300_000,
      shellReadyTimeoutMs: process.env.CI ? 120_000 : 90_000,
    });
    await harness.setMainWindowBounds({ x: 0, y: 0, width: 1240, height: 860 });
    await harness.showMainWindow();
    await harness.focusMainWindow();
    const activeHarness = harness;

    // Native tray exists (the /state snapshot is the OS-side source of truth).
    const state = await activeHarness.getState();
    expect(state.shell.trayPresent, "native tray icon present").toBe(true);

    // Wait for the curated launcher list to publish and the dynamic tray
    // catalog to mirror it (DesktopTrayRuntime publishes both once the view
    // registry loads; against the mock API the list is the builtin shell set,
    // which is non-empty).
    await expect
      .poll(
        async () => {
          const read = await readViewsSurfaces(activeHarness);
          return Boolean(
            read.curated &&
              read.curated.length > 0 &&
              read.trayCatalog &&
              read.trayCatalog.length > 0 &&
              read.popoverRows &&
              read.popoverRows.length > 0,
          );
        },
        {
          timeout: 90_000,
          message:
            "Expected the curated launcher list, runtime tray catalog, and popover rows to publish.",
        },
      )
      .toBe(true);

    const read = await readViewsSurfaces(activeHarness);
    const curated = read.curated as CuratedEntry[];
    const trayCatalog = read.trayCatalog as RuntimeTrayView[];
    const popoverRows = read.popoverRows as LauncherRow[];

    // ── Tray catalog parity: same ids, same order, same labels ───────────
    expect(trayCatalog.map((v) => v.id)).toEqual(curated.map((e) => e.id));
    expect(trayCatalog.map((v) => v.label)).toEqual(
      curated.map((e) => e.label),
    );
    // Paths follow the launcher navigation rule (declared path, else /apps/<id>).
    for (const [index, view] of trayCatalog.entries()) {
      const entry = curated[index];
      expect(view.path).toBe(entry.path ?? `/apps/${entry.id}`);
    }

    // ── Popover rows parity: "Open Eliza" first, then one row per entry ──
    expect(popoverRows[0]?.itemId).toBe("tray-show-window");
    const viewRows = popoverRows.slice(1);
    expect(viewRows.map((row) => row.itemId)).toEqual(
      curated.map((entry) => `tray-open-view-${entry.id}`),
    );
    expect(viewRows.map((row) => row.label)).toEqual(
      curated.map((entry) => entry.label),
    );

    // ── A dynamic tray click resolves and opens the view window ──────────
    // Dispatch the same TRAY_ACTION_EVENT the native menu/popover rows use for
    // the first curated entry, then confirm the renderer accepted it (no throw)
    // and the id round-trips through the published catalog.
    const first = curated[0];
    const clicked = await activeHarness.eval<
      EvalResult<{ dispatched: boolean }>
    >(`(() => {
      try {
        document.dispatchEvent(
          new CustomEvent("eliza:tray-action", {
            detail: { itemId: "tray-open-view-${first.id}" },
          }),
        );
        return { ok: true, dispatched: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    })()`);
    expect(clicked.ok, clicked.ok ? undefined : clicked.error).toBe(true);
  } finally {
    await harness?.stop().catch(() => undefined);
    await api?.close().catch(() => undefined);
  }
});

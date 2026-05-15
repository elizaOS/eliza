/**
 * Real-mode display enumeration + capture for the vision-CUA E2E harness.
 *
 * Wraps the workspace's `plugin-computeruse` capture and display-enumeration
 * primitives behind the same `DisplayCaptureFixture` shape the stub mode
 * uses, so `runDisplay()` in `pipeline.ts` can be agnostic to the source.
 *
 * We import directly from the workspace TS source because the bundled
 * `dist/index.js` does not re-export `captureAllDisplays`, `listDisplays`,
 * or `NoDisplayError` (only `captureDesktopScreenshot`, which is the
 * legacy single-display API). The TS path is safe at runtime under bun /
 * vitest, which both transpile on-the-fly.
 */

import type { DisplayCaptureFixture, DisplayConfig } from "./types.ts";

interface PluginComputerUseDisplaysModule {
  readonly listDisplays: () => Array<{
    id: number;
    bounds: [number, number, number, number];
    scaleFactor: number;
    primary: boolean;
    name: string;
  }>;
  readonly isHeadless: () => boolean;
  readonly NoDisplayError: new (msg: string) => Error & { code: "NO_DISPLAY" };
}

interface PluginComputerUseCaptureModule {
  readonly captureAllDisplays: () => Promise<
    Array<{
      display: {
        id: number;
        bounds: [number, number, number, number];
        scaleFactor: number;
        primary: boolean;
        name: string;
      };
      frame: Buffer;
    }>
  >;
  readonly captureDisplay: (id: number) => Promise<{
    display: {
      id: number;
      bounds: [number, number, number, number];
      scaleFactor: number;
      primary: boolean;
      name: string;
    };
    frame: Buffer;
  }>;
}

export interface RealCaptureResult {
  /** The fixture-shaped capture per display (PNG bytes for before + after). */
  readonly captures: ReadonlyArray<DisplayCaptureFixture>;
  /** Provider info recorded in the trace. */
  readonly providerInfo: {
    readonly enumeratorName: string;
    readonly captureName: string;
  };
}

/**
 * Capture every attached display twice (frame + frame-after, with a small
 * delay between the two captures so a perceptual-diff verifier has data).
 *
 * Throws on a truly headless host. Throws if the underlying capture tool is
 * missing (Linux requires `import` / `scrot` / `gnome-screenshot`).
 */
export async function captureRealDisplays(
  options: { readonly delayMs?: number } = {},
): Promise<RealCaptureResult> {
  const displaysModule = (await import(
    "../../../../plugins/plugin-computeruse/src/platform/displays.ts" as string
  )) as PluginComputerUseDisplaysModule;
  const captureModule = (await import(
    "../../../../plugins/plugin-computeruse/src/platform/capture.ts" as string
  )) as PluginComputerUseCaptureModule;

  if (displaysModule.isHeadless()) {
    throw new displaysModule.NoDisplayError(
      "[vision-cua-e2e] capture refused: host is headless (no DISPLAY/WAYLAND_DISPLAY).",
    );
  }

  const before = await captureModule.captureAllDisplays();
  await wait(options.delayMs ?? 200);
  const after = await captureModule.captureAllDisplays();

  if (before.length === 0) {
    throw new Error(
      "[vision-cua-e2e] capture returned 0 displays — refusing to proceed.",
    );
  }
  if (before.length !== after.length) {
    throw new Error(
      `[vision-cua-e2e] display count changed mid-capture (${before.length} → ${after.length}).`,
    );
  }

  const captures: DisplayCaptureFixture[] = before.map((cap, idx) => {
    const a = after[idx];
    if (!a) {
      throw new Error(
        `[vision-cua-e2e] missing recapture for display ${cap.display.id}`,
      );
    }
    const display: DisplayConfig = {
      id: cap.display.id,
      name: cap.display.name,
      bounds: cap.display.bounds,
      scaleFactor: cap.display.scaleFactor,
      primary: cap.display.primary,
    };
    return {
      display,
      frame: new Uint8Array(cap.frame),
      frameAfter: new Uint8Array(a.frame),
    };
  });

  return {
    captures,
    providerInfo: {
      enumeratorName: "plugin-computeruse/platform/displays",
      captureName: "plugin-computeruse/platform/capture",
    },
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

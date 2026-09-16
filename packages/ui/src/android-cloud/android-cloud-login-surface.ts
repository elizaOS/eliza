/**
 * Owns the native child WebView used by the Play Cloud sign-in flow.
 *
 * The login page is intentionally isolated from the host WebView's renderer
 * and storage partition, but it is still layered inside the app window. The
 * Cloud shell polls the short-lived login session independently, so the
 * surface never needs to read credentials or inspect the third-party page.
 */

import { CapacitorNativeSurfaceShell } from "../surface/capacitor-native-surface-shell";

const LOGIN_SURFACE_ID = "android-cloud-login";
const LOGIN_SURFACE_OWNER = "eliza-android-cloud-login";
const LOGIN_SURFACE_HEADER_HEIGHT = 72;
const LOGIN_SURFACE_MARGIN = 12;
const LOGIN_SURFACE_RADIUS = 16;

export interface AndroidCloudLoginSurface {
  open(url: string): Promise<void>;
  close(): Promise<void>;
}

export interface AndroidCloudLoginSurfaceBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  outerClip: {
    x: number;
    y: number;
    width: number;
    height: number;
    cornerRadii: {
      topLeft: number;
      topRight: number;
      bottomRight: number;
      bottomLeft: number;
    };
  };
}

/** Keep the native page below the host-rendered cancel/header affordance. */
export function getAndroidCloudLoginSurfaceBounds(
  viewport: { width: number; height: number } = {
    width: typeof window === "undefined" ? 0 : window.innerWidth,
    height: typeof window === "undefined" ? 0 : window.innerHeight,
  },
): AndroidCloudLoginSurfaceBounds {
  const x = LOGIN_SURFACE_MARGIN;
  const y = LOGIN_SURFACE_HEADER_HEIGHT;
  const width = Math.max(0, viewport.width - LOGIN_SURFACE_MARGIN * 2);
  const height = Math.max(
    0,
    viewport.height - LOGIN_SURFACE_HEADER_HEIGHT - LOGIN_SURFACE_MARGIN,
  );
  return {
    x,
    y,
    width,
    height,
    outerClip: {
      x,
      y,
      width,
      height,
      cornerRadii: {
        topLeft: LOGIN_SURFACE_RADIUS,
        topRight: LOGIN_SURFACE_RADIUS,
        bottomRight: LOGIN_SURFACE_RADIUS,
        bottomLeft: LOGIN_SURFACE_RADIUS,
      },
    },
  };
}

/**
 * Build the production adapter over `ElizaSurfaceManager`. This native-only
 * implementation deliberately has no system-browser fallback: if the device
 * cannot provide the isolated in-app surface, sign-in fails visibly.
 */
export function createAndroidCloudLoginSurface(): AndroidCloudLoginSurface {
  const session =
    typeof globalThis.crypto?.randomUUID === "function"
      ? `login-realm-${globalThis.crypto.randomUUID()}`
      : `login-realm-${Date.now().toString(36)}`;
  const shell = new CapacitorNativeSurfaceShell(undefined, {
    owner: LOGIN_SURFACE_OWNER,
    session,
    epoch: Date.now(),
  });
  let opened = false;
  let resizeHandler: (() => void) | null = null;

  const updateBounds = async (): Promise<void> => {
    await shell.setBounds(
      LOGIN_SURFACE_ID,
      getAndroidCloudLoginSurfaceBounds(),
    );
    await shell.setOcclusionRects(LOGIN_SURFACE_ID, [
      {
        x: 0,
        y: 0,
        width: typeof window === "undefined" ? 0 : window.innerWidth,
        height: LOGIN_SURFACE_HEADER_HEIGHT,
        cornerRadius: 0,
      },
    ]);
  };

  return {
    async open(url) {
      if (!/^https:\/\//i.test(url)) {
        throw new Error("Eliza sign-in must use HTTPS.");
      }
      try {
        await shell.createSurface({
          id: LOGIN_SURFACE_ID,
          url,
          policy: { process: "isolated", storage: "isolated" },
        });
        await updateBounds();
        await shell.presentSurface(LOGIN_SURFACE_ID);
        opened = true;
        if (typeof window !== "undefined") {
          resizeHandler = () => {
            void updateBounds().catch((error: unknown) => {
              // error-policy:J6 a resize racing native teardown is harmless;
              // the next login creates fresh geometry from the current viewport.
              void error;
            });
          };
          window.addEventListener("resize", resizeHandler);
        }
      } catch (error) {
        try {
          await shell.destroySurface(LOGIN_SURFACE_ID);
        } catch (closeError) {
          // error-policy:J6 best-effort cleanup after a failed surface launch;
          // preserve the original native launch error for the UI.
          void closeError;
        }
        throw error;
      }
    },
    async close() {
      if (!opened) return;
      if (resizeHandler && typeof window !== "undefined") {
        window.removeEventListener("resize", resizeHandler);
        resizeHandler = null;
      }
      try {
        await shell.destroySurface(LOGIN_SURFACE_ID);
      } finally {
        opened = false;
      }
    },
  };
}

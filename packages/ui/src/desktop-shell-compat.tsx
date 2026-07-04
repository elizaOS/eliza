/**
 * No-op desktop shell runtime components for non-desktop builds, so the shell can
 * render the same tree without the desktop-only surfaces.
 */
export function DesktopSurfaceNavigationRuntime(): null {
  return null;
}

export function DesktopTrayRuntime(): null {
  return null;
}

export interface DetachedShellRootProps {
  route?: unknown;
}

export function DetachedShellRoot(_props: DetachedShellRootProps): null {
  return null;
}

/** Detects the standalone Vite renderer shell whose origin has no embedded backend. */

const VITE_DEV_UI_PORT = "2138";

export function isViteDevUiShell(location?: Pick<Location, "port">): boolean {
  const browserLocation =
    location ?? (typeof window === "undefined" ? undefined : window.location);
  return browserLocation?.port === VITE_DEV_UI_PORT;
}

/**
 * Registers the `Desktop` Capacitor plugin exposing system tray, global
 * shortcuts, window management, notifications, clipboard, power monitor, and
 * OS permission probing to the Eliza agent desktop UI. Capacitor resolves the
 * native side from the host app's Electrobun plugin registration; `loadWeb`
 * supplies the browser fallback (`DesktopWeb` in `./web`) whenever that
 * native bridge isn't present, e.g. running in a plain browser tab.
 */
import { registerPlugin } from "@capacitor/core";

import type { DesktopPlugin } from "./definitions";

export * from "./definitions";

const loadWeb = () => import("./web").then((m) => new m.DesktopWeb());

export const Desktop = registerPlugin<DesktopPlugin>("Desktop", {
  web: loadWeb,
});

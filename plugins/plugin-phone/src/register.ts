/**
 * Side-effect entry point for bundled phone surfaces.
 *
 * The Phone Companion is an app-shell page and must register on every host
 * where the app shell can route to `/phone-companion`. The Android overlay app
 * still only registers on ElizaOS.
 */

import { isElizaOS } from "@elizaos/ui";
import { registerPhoneApp } from "./components/phone-app";
import "./register-companion-page";

if (isElizaOS()) {
  registerPhoneApp();
}

// In a terminal host (the Node agent, no DOM), register the phone view so it
// renders inline in the terminal. Lazy + DOM-guarded so the terminal engine
// stays out of browser/mobile bundles.
if (typeof window === "undefined") {
  void import("./register-terminal-view")
    .then((m) => m.registerPhoneTerminalView())
    .catch(() => {
      // Terminal rendering is best-effort; never block plugin load.
    });
}

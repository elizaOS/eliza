#!/usr/bin/env node
/**
 * Ensures platform-specific dependencies are installed for computer-use.
 *
 * Default driver = nutjs (cross-platform native bindings). With nutjs, no
 * shell tools are required — this script exits early after confirming the
 * native module loads. Set ELIZA_COMPUTERUSE_DRIVER=legacy to switch back
 * to the per-OS shell drivers (cliclick / xdotool / PowerShell), in which
 * case this script ensures those tools are present.
 *
 * macOS:  installs cliclick via Homebrew (fast, reliable mouse/keyboard control)
 * Linux:  checks for xdotool, suggests install command
 * Windows: no extra deps needed (PowerShell built-in)
 *
 * This runs as a postinstall hook — it's best-effort and never fails the install.
 */

import { execSync } from "node:child_process";
import { platform } from "node:os";

const driver = (process.env.ELIZA_COMPUTERUSE_DRIVER ?? "nutjs")
  .trim()
  .toLowerCase();

if (driver === "nutjs") {
  console.log(
    "[computeruse] Driver = nutjs (cross-platform). Skipping shell-tool checks.",
  );
  console.log(
    "[computeruse] Set ELIZA_COMPUTERUSE_DRIVER=legacy to switch to per-OS shell drivers.",
  );
  process.exit(0);
}

function commandExists(cmd) {
  try {
    const which = platform() === "win32" ? "where" : "which";
    execSync(`${which} ${cmd}`, { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function run(cmd) {
  try {
    execSync(cmd, { stdio: "inherit", timeout: 120000 });
    return true;
  } catch {
    return false;
  }
}

const os = platform();

if (os === "darwin") {
  // macOS: install cliclick for fast, reliable mouse/keyboard control
  if (!commandExists("cliclick")) {
    if (commandExists("brew")) {
      console.log(
        "[computeruse] Installing cliclick via Homebrew (fast mouse/keyboard control)...",
      );
      if (run("brew install cliclick")) {
        console.log("[computeruse] cliclick installed successfully.");
      } else {
        console.log(
          "[computeruse] cliclick install failed — falling back to AppleScript (slower).",
        );
        console.log("[computeruse] To install manually: brew install cliclick");
      }
    } else {
      console.log(
        "[computeruse] Homebrew not found. For best performance, install cliclick:",
      );
      console.log(
        '[computeruse]   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      );
      console.log("[computeruse]   brew install cliclick");
      console.log(
        "[computeruse] Falling back to AppleScript for mouse/keyboard control.",
      );
    }
  } else {
    console.log("[computeruse] cliclick already installed.");
  }
} else if (os === "linux") {
  // Linux: check for xdotool
  if (!commandExists("xdotool")) {
    console.log(
      "[computeruse] xdotool not found — required for mouse/keyboard control on Linux.",
    );
    console.log("[computeruse] Install via: sudo apt install xdotool");
    console.log("[computeruse] Or: sudo dnf install xdotool");
    console.log("[computeruse] Or: sudo pacman -S xdotool");
  }

  // Check for screenshot tool
  if (
    !commandExists("import") &&
    !commandExists("scrot") &&
    !commandExists("gnome-screenshot")
  ) {
    console.log("[computeruse] No screenshot tool found. Install one of:");
    console.log(
      "[computeruse]   sudo apt install imagemagick   (provides 'import')",
    );
    console.log("[computeruse]   sudo apt install scrot");
    console.log("[computeruse]   sudo apt install gnome-screenshot");
  }
} else if (os === "win32") {
  console.log(
    "[computeruse] Windows detected — using built-in PowerShell for automation.",
  );
}

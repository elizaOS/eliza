import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Detects hosts where invoking `@napi-rs/keyring` is known to crash
 * the process at the native level instead of throwing a catchable JS
 * error:
 *
 *   - explicit opt-out via `CONFIDANT_DISABLE_KEYCHAIN=1`
 *   - headless Linux with no reachable D-Bus session (the libsecret
 *     backend aborts at the C level when it can't reach the Secret
 *     Service)
 *
 * D-Bus reachability on Linux is checked two ways:
 *
 *   1. `DBUS_SESSION_BUS_ADDRESS` env var — the classical signal.
 *   2. `$XDG_RUNTIME_DIR/bus` socket — modern systemd user sessions
 *      socket-activate D-Bus and don't always export the env var
 *      (notably SSH sessions without env forwarding, and Fedora /
 *      Arch / Ubuntu 22+ desktops).
 *
 * Either signal is sufficient; both absent means refuse the keychain.
 */
export function isKeychainUnsafe(): boolean {
  if (process.env.CONFIDANT_DISABLE_KEYCHAIN === "1") return true;
  if (process.platform !== "linux") return false;
  if (process.env.DBUS_SESSION_BUS_ADDRESS) return false;
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime && existsSync(join(xdgRuntime, "bus"))) return false;
  return true;
}

export const KEYCHAIN_UNSAFE_MESSAGE =
  "OS keychain unsafe on this host (headless Linux with no reachable D-Bus session, or CONFIDANT_DISABLE_KEYCHAIN=1). On Linux, ensure libsecret + a Secret Service agent (gnome-keyring / kwallet) is running, or use a different backend.";

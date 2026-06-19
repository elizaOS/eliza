/**
 * Full Disk Access prober.
 *
 * macOS has no public API to query Full Disk Access. The accepted
 * heuristic is to attempt to read a file that lives behind FDA in the
 * user's Library — `~/Library/Mail/V<N>/MailData/Accounts.plist` is a
 * canonical FDA-only file.
 *
 * There's no API to request FDA either; the user must add the app
 * manually in System Settings → Privacy & Security → Full Disk Access.
 * `request()` opens that pane and returns the post-open status.
 *
 * Status semantics:
 *   - granted: read succeeded
 *   - denied:  read EACCES'd (FDA explicitly missing)
 *   - not-determined: target file doesn't exist (user has no Mail.app
 *     setup) — we can't tell. Fall back to a second probe against
 *     ~/Library/Safari (also FDA-gated and almost always present).
 */

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PermissionState, Prober } from "../contracts.js";
import {
  buildState,
  IS_DARWIN,
  openPrivacyPane,
  platformUnsupportedState,
} from "./_bridge.js";

const ID = "full-disk" as const;

const FDA_PROBES = [
  "Library/Mail",
  "Library/Safari/Bookmarks.plist",
  "Library/Application Support/com.apple.TCC/TCC.db",
];

async function probeFullDisk(): Promise<
  "granted" | "denied" | "not-determined"
> {
  for (const rel of FDA_PROBES) {
    const target = path.join(os.homedir(), rel);
    // Listing the directory or stat'ing the file is enough — macOS
    // returns EACCES when FDA is missing.
    try {
      if (!existsSync(target)) continue;
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        await fs.readdir(target);
      } else {
        // Open + close — read 0 bytes to avoid loading large files.
        const fh = await fs.open(target, "r");
        await fh.close();
      }
      return "granted";
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EACCES" || code === "EPERM") return "denied";
      // Other errors (ENOENT after existsSync = race) — try next.
    }
  }
  return "not-determined";
}

export const fullDiskProber: Prober = {
  id: ID,

  async check(): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    const status = await probeFullDisk();
    return buildState(ID, status, {
      // FDA cannot be requested programmatically; canRequest=false
      // even when we don't know.
      canRequest: false,
    });
  },

  async request({ reason: _reason }): Promise<PermissionState> {
    if (!IS_DARWIN) return platformUnsupportedState(ID);
    await openPrivacyPane("AllFiles");
    const state = await fullDiskProber.check();
    return { ...state, lastRequested: Date.now() };
  },
};

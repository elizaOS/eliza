/**
 * Real-driver verification of the cua-parity input verbs (#9105).
 * Gated: runs only on a Windows host with a desktop session (and in Windows CI).
 *
 * - get_cursor_position: move then read back the OS cursor (uses the native
 *   System.Windows.Forms.Cursor query on Windows because nutjs getPosition()
 *   returns a stale constant there).
 * - clipboard: write then read round-trips (Set-Clipboard via
 *   [Console]::In.ReadToEnd()).
 */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { readClipboard, writeClipboard } from "../platform/clipboard.js";
import {
  driverGetCursorPosition,
  driverMouseMove,
} from "../platform/driver.js";

const RUN = platform() === "win32";

describe("cua parity input (real driver, Windows)", () => {
  it.skipIf(!RUN)(
    "get_cursor_position reflects driverMouseMove",
    async () => {
      for (const [x, y] of [
        [320, 240],
        [640, 480],
      ] as const) {
        await driverMouseMove(x, y);
        await new Promise((r) => setTimeout(r, 150));
        const pos = await driverGetCursorPosition();
        expect(Math.abs(pos.x - x)).toBeLessThanOrEqual(2);
        expect(Math.abs(pos.y - y)).toBeLessThanOrEqual(2);
      }
    },
    20000,
  );

  it.skipIf(!RUN)(
    "clipboard write/read round-trips",
    async () => {
      const token = `eliza-clip-${Date.now()}`;
      await writeClipboard(token);
      const back = (await readClipboard()).trim();
      expect(back).toBe(token);
    },
    20000,
  );
});

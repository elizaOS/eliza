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
  driverDragPath,
  driverGetCursorPosition,
  driverKeyDown,
  driverKeyUp,
  driverMiddleClick,
  driverMouseDown,
  driverMouseMove,
  driverMouseUp,
} from "../platform/driver.js";

// Run the real-driver lane wherever a real host driver + display session is
// available — not just Windows. macOS runners are headful; Linux needs an X
// display (Xvfb in CI). The previous win32-only gate silently skipped Linux/macOS
// and let the M8 key_down("shift") bug (#9189) ship. See TRYCUA_PARITY_AUDIT.md
// §3 — the matching CI lanes (Xvfb on Linux, headful macOS) are the remaining M14
// step.
const os = platform();
const RUN =
  os === "win32" ||
  os === "darwin" ||
  (os === "linux" && Boolean(process.env.DISPLAY));

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

  // ── M8 verb-parity pack (real driver) ───────────────────────────────────

  it.skipIf(!RUN)(
    "middle_click fires without throwing",
    async () => {
      await driverMouseMove(400, 300);
      await expect(driverMiddleClick(400, 300)).resolves.toBeUndefined();
    },
    20000,
  );

  it.skipIf(!RUN)(
    "mouse_down/mouse_up press-hold round-trips (always releases)",
    async () => {
      await driverMouseMove(420, 320);
      await driverMouseDown(420, 320, "left");
      try {
        const pos = await driverGetCursorPosition();
        expect(Math.abs(pos.x - 420)).toBeLessThanOrEqual(2);
      } finally {
        // Never leave a button held, even on assertion failure.
        await driverMouseUp(420, 320, "left");
      }
    },
    20000,
  );

  it.skipIf(!RUN)(
    "key_down/key_up press-hold round-trips (always releases)",
    async () => {
      await driverKeyDown("shift");
      await driverKeyUp("shift");
    },
    20000,
  );

  it.skipIf(!RUN)(
    "multi-point drag path lands the cursor on the final vertex",
    async () => {
      await driverDragPath([
        { x: 300, y: 300 },
        { x: 500, y: 300 },
        { x: 500, y: 450 },
      ]);
      await new Promise((r) => setTimeout(r, 150));
      const pos = await driverGetCursorPosition();
      expect(Math.abs(pos.x - 500)).toBeLessThanOrEqual(3);
      expect(Math.abs(pos.y - 450)).toBeLessThanOrEqual(3);
    },
    20000,
  );
});

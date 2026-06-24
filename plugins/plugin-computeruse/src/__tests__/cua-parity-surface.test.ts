/**
 * trycua/cua parity surface (#9105) — verify the newly-exposed computer-use
 * capabilities are actually registered and wired:
 *   - CLIPBOARD (read/write) is registered (was defined-but-unregistered).
 *   - COMPUTER_USE exposes a get_cursor_position verb.
 * Plus a regression guard on the Windows clipboard-write command (the previous
 * `$input | Set-Clipboard` hung; it must read stdin via [Console]::In.ReadToEnd()).
 */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import { computerUsePlugin } from "../index.js";
import { __testing } from "../platform/clipboard.js";

const actionNames = (computerUsePlugin.actions ?? []).map((a) => a.name);

describe("cua parity surface", () => {
  it("registers the CLIPBOARD action (read/write)", () => {
    const hasClipboard = actionNames.some((n) => /CLIPBOARD/i.test(n));
    expect(hasClipboard, `actions: ${actionNames.join(", ")}`).toBe(true);
    // Promoted subactions present.
    expect(actionNames).toContain("CLIPBOARD_READ");
    expect(actionNames).toContain("CLIPBOARD_WRITE");
  });

  it("exposes a get_cursor_position computer-use verb", () => {
    expect(actionNames).toContain("COMPUTER_USE_GET_CURSOR_POSITION");
  });

  it("promotes the M8 verb-parity pack (middle_click, mouse/key down-up)", () => {
    for (const verb of [
      "COMPUTER_USE_MIDDLE_CLICK",
      "COMPUTER_USE_MOUSE_DOWN",
      "COMPUTER_USE_MOUSE_UP",
      "COMPUTER_USE_KEY_DOWN",
      "COMPUTER_USE_KEY_UP",
    ]) {
      expect(actionNames, `actions: ${actionNames.join(", ")}`).toContain(verb);
    }
  });
});

describe("clipboard write command (Windows regression)", () => {
  it.skipIf(platform() !== "win32")(
    "reads stdin via [Console]::In.ReadToEnd(), not $input",
    () => {
      const plan = __testing.pickPlan();
      const joined = plan.write.args.join(" ");
      expect(joined).toContain("ReadToEnd");
      expect(joined).not.toContain("$input | Set-Clipboard");
    },
  );
});

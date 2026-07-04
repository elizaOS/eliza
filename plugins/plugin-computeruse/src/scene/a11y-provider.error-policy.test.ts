/**
 * Error-policy tests for the accessibility providers' snapshot failure path
 * (#12273). The interface contract is that `snapshot()` returns `[]` for "no
 * reachable nodes" so the scene-builder always produces a Scene — but a genuine
 * failure (the platform a11y binary missing, or permission revoked) must not be
 * silently indistinguishable from an empty desktop. These tests drive the real
 * missing-binary path (osascript/powershell are absent on the Linux CI host) and
 * assert the failure is surfaced via `logger.warn`, not swallowed.
 */

import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DarwinAccessibilityProvider,
  WindowsAccessibilityProvider,
} from "./a11y-provider.js";

const onDarwin = process.platform === "darwin";
const onWindows = process.platform === "win32";

describe("accessibility provider snapshot failure surfacing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.skipIf(onDarwin)(
    "Darwin provider surfaces the osascript failure via logger.warn and still returns []",
    async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      // osascript does not exist on a non-macOS host → execFileSync throws.
      const nodes = await new DarwinAccessibilityProvider().snapshot();

      expect(nodes).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "[DarwinAccessibilityProvider]",
      );
    },
  );

  it.skipIf(onWindows)(
    "Windows provider surfaces the PowerShell failure via logger.warn and still returns []",
    async () => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

      // powershell does not exist on a non-Windows host → execFileSync throws.
      const nodes = await new WindowsAccessibilityProvider().snapshot();

      expect(nodes).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(
        "[WindowsAccessibilityProvider]",
      );
    },
  );
});

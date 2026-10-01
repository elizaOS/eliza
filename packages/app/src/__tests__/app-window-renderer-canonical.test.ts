/**
 * Regression: `@elizaos/app` must expose the canonical `AppWindowRenderer`
 * from `@elizaos/ui`, not a divergent app-local fork that shadows it.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AppWindowRenderer as CanonicalAppWindowRenderer } from "@elizaos/ui/components/apps/AppWindowRenderer";
import { describe, expect, it, vi } from "vitest";

describe("AppWindowRenderer exports", () => {
  it("desktop-shell re-exports the ui canonical component", async () => {
    // test/setup.ts mocks the desktop-shell entry; load the real module.
    const shell =
      await vi.importActual<typeof import("../desktop-shell")>(
        "../desktop-shell",
      );
    expect(shell.AppWindowRenderer).toBe(CanonicalAppWindowRenderer);
  }, 300_000);

  it("browser barrel resolves to the ui canonical component", async () => {
    const browser = await import("../browser");
    expect(browser.AppWindowRenderer).toBe(CanonicalAppWindowRenderer);
  }, 300_000);

  it("does not keep an app-local renderer fork", () => {
    expect(
      existsSync(
        resolve(__dirname, "../runtime/desktop/AppWindowRenderer.tsx"),
      ),
    ).toBe(false);
  });
});

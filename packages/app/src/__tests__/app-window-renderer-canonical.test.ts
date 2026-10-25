/**
 * Regression: The public UI entry and lazy loader expose the same AppWindowRenderer.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AppWindowRenderer as CanonicalAppWindowRenderer } from "../../../ui/src/components/apps/AppWindowRenderer";

describe("AppWindowRenderer exports", () => {
  it("public UI entry exposes the canonical component", async () => {
    const ui = await import("@elizaos/ui");
    expect(ui.AppWindowRenderer).toBe(CanonicalAppWindowRenderer);
  }, 300_000);

  it("lazy loader resolves to the canonical component", async () => {
    const { loadAppWindowRenderer } = await import("@elizaos/ui");
    expect((await loadAppWindowRenderer()).AppWindowRenderer).toBe(
      CanonicalAppWindowRenderer,
    );
  }, 300_000);

  it("does not keep an app-local renderer fork", () => {
    expect(
      existsSync(
        resolve(__dirname, "../runtime/desktop/AppWindowRenderer.tsx"),
      ),
    ).toBe(false);
  });
});

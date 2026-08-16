/**
 * Pins packaged app windows to the desktop renderer that owns builtin tools,
 * registered app-shell pages, overlay apps, and external catalog apps.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MAIN_SOURCE = readFileSync(
  resolve(import.meta.dirname, "main.tsx"),
  "utf8",
);
const DESKTOP_RENDERER_SOURCE = readFileSync(
  resolve(
    import.meta.dirname,
    "../../app-core/src/runtime/desktop/AppWindowRenderer.tsx",
  ),
  "utf8",
);

describe("packaged app-window renderer ownership", () => {
  it("routes app windows through the complete desktop renderer", () => {
    const rendererBoundary = MAIN_SOURCE.slice(
      MAIN_SOURCE.indexOf("const AppWindowRenderer"),
      MAIN_SOURCE.indexOf("/** Desktop-only shell widgets"),
    );

    expect(rendererBoundary).toContain(
      'import("@elizaos/app-core/desktop-shell")',
    );
    expect(rendererBoundary).not.toContain(
      'import("@elizaos/ui/components/apps/AppWindowRenderer")',
    );
    expect(DESKTOP_RENDERER_SOURCE).toContain("getInternalToolAppDescriptors");
    expect(DESKTOP_RENDERER_SOURCE).toContain("renderInternalToolTab");
  });
});

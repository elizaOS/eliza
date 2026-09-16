/**
 * Guards the Browser workspace's static chat-clearance ownership contract; the
 * Playwright smoke suite separately proves the rendered safe-area geometry.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("browser overlay clearance regression (#14320)", () => {
  const source = readFileSync(
    resolve(
      process.cwd(),
      "../ui/src/components/pages/BrowserWorkspaceView.tsx",
    ),
    "utf8",
  );

  it("ends the live page and native-surface anchor above the resting chat footprint", () => {
    expect(source).toContain('data-chat-clearance-aware="true"');
    expect(source).toContain('data-testid="browser-workspace-surface-panel"');
    expect(source).toContain("var(--eliza-chat-clearance,5.25rem)");
    expect(source).not.toContain("var(--eliza-mobile-nav-offset,0px)");
    expect(source).not.toContain("var(--safe-area-bottom,0px)");
    expect(source).not.toContain("var(--android-gesture-inset-bottom,0px)");
  });
});

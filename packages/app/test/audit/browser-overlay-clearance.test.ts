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

  it("keeps the bridge action grid out of the mobile-landscape chat affordance corner", () => {
    expect(source).toContain("browserworkspace.RefreshBrowserBridge");
    // The chat bottom + side clearances are reserved exactly ONCE, on the
    // designed-empty scroller, so the bridge grid clears the compact corner
    // composer in short landscape without double-counting the inset (the
    // double reservation squeezed the column off-canvas).
    expect(source).toContain("pe-[var(--eliza-chat-side-clearance,0px)]");
    expect(source).toContain(
      "pb-[calc(var(--eliza-chat-clearance,5.25rem)+1rem)]",
    );
    expect(source).not.toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:pe-",
    );
    expect(source).not.toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:pb-",
    );
  });
});

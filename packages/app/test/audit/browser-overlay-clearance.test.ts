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
    expect(source).toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:pe-[var(--eliza-continuous-chat-side-clearance,0px)]",
    );
    expect(source).toContain(
      "[@media(orientation:landscape)_and_(max-height:520px)]:pb-[var(--eliza-continuous-chat-clearance,5.25rem)]",
    );
  });
});

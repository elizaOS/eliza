import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function readComponent(name: string): string {
  return readFileSync(resolve(here, name), "utf8");
}

describe("LifeOps visual copy", () => {
  it("keeps money section empty states compact and separator text plain", () => {
    const source = readComponent("LifeOpsMoneySection.tsx");

    expect(source).not.toContain('<p className="text-xs text-muted"');
    expect(source).not.toContain(" → ");
    expect(source).not.toContain(" · ");
    expect(source).not.toContain("×");
  });

  it("keeps messaging and sleep connector copy free of raw arrow or dot separators", () => {
    const messaging = readComponent("MessagingConnectorCards.tsx");
    const sleep = readComponent("SleepInspectionPanel.tsx");

    expect(messaging).not.toContain(" → ");
    expect(messaging).not.toContain(" • ");
    expect(sleep).not.toContain(" → ");
    expect(sleep).not.toContain(" · ");
  });

  it("keeps reminder controls from reintroducing paragraph helper copy", () => {
    const source = readComponent("LifeOpsRemindersSection.tsx");

    expect(source).not.toContain("<p className=");
    expect(source).not.toContain(" → ");
    expect(source).not.toContain(" · ");
  });
});

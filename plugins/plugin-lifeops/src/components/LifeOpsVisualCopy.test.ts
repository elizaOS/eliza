import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

function readComponent(name: string): string {
  return readFileSync(resolve(here, name), "utf8");
}

describe("LifeOps visual copy", () => {
  it("keeps LifeOps app metadata focused on personal assistant ownership", () => {
    const pluginSource = readFileSync(resolve(here, "../plugin.ts"), "utf8");
    const uiSource = readFileSync(resolve(here, "../ui.ts"), "utf8");
    const metadataSource = `${pluginSource}\n${uiSource}`;

    expect(metadataSource).toContain("Personal assistant workspace");
    expect(metadataSource).toContain('"assistant"');
    expect(metadataSource).not.toContain('"health"');
    expect(metadataSource).not.toContain("and health");
    expect(metadataSource).not.toContain("screen-time");
    expect(metadataSource).not.toContain("screen time");
  });

  it("keeps money section empty states compact and separator text plain", () => {
    const source = readComponent("LifeOpsMoneySection.tsx");

    expect(source).not.toContain('<p className="text-xs text-muted"');
    expect(source).not.toContain(" → ");
    expect(source).not.toContain(" · ");
    expect(source).not.toContain("×");
  });

  it("keeps messaging connector copy free of raw arrow or dot separators", () => {
    const messaging = readComponent("MessagingConnectorCards.tsx");

    expect(messaging).not.toContain(" → ");
    expect(messaging).not.toContain(" • ");
  });

  it("keeps reminder controls from reintroducing paragraph helper copy", () => {
    const source = readComponent("LifeOpsRemindersSection.tsx");

    expect(source).not.toContain("<p className=");
    expect(source).not.toContain(" → ");
    expect(source).not.toContain(" · ");
  });
});

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

  it("keeps overview assistant-first and free of dashboard loading copy", () => {
    const source = readComponent("LifeOpsOverviewSection.tsx");

    expect(source).toContain("LifeOpsOverviewAssistantDock");
    expect(source).toContain("lifeops-overview-assistant-dock");
    expect(source).toContain("lifeops-overview-signals");
    expect(source).not.toContain('title="Sleep"');
    expect(source).not.toContain('title="Screen Time"');
    expect(source).not.toContain('title="Social"');
    expect(source).not.toContain("Loading dashboard");
    expect(source).not.toContain("Reading screen time");
    expect(source).not.toContain("Weekly comparison unavailable");
  });

  it("keeps desktop navigation compact and active-label only", () => {
    const shell = readComponent("LifeOpsWorkspaceShell.tsx");
    const nav = readComponent("LifeOpsNavRail.tsx");

    expect(shell).toContain('labelMode="active"');
    expect(shell).toContain('storageKey="lifeops:nav-rail-width:compact"');
    expect(shell).not.toContain("defaultWidth={296}");
    expect(nav).toContain('labelMode?: "all" | "active"');
  });
});

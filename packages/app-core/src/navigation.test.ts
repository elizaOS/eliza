import {
  ALL_TAB_GROUPS,
  APPS_ENABLED,
  getTabGroups,
  pathForTab,
  type Tab,
  tabFromPath,
  titleForTab,
} from "@elizaos/app-core/navigation";
import { describe, expect, it } from "vitest";

describe("tabFromPath", () => {
  it("maps core tabs", () => {
    expect(tabFromPath("/")).toBe("chat");
    expect(tabFromPath("/chat")).toBe("chat");
    expect(tabFromPath("/companion")).toBe("companion");
    expect(tabFromPath("/stream")).toBe("stream");
    expect(tabFromPath("/character")).toBe("character");
    expect(tabFromPath("/character-select")).toBe("character-select");
    expect(tabFromPath("/wallets")).toBe("wallets");
    expect(tabFromPath("/knowledge")).toBe("knowledge");
    expect(tabFromPath("/connectors")).toBe("connectors");
    expect(tabFromPath("/settings")).toBe("settings");
    expect(tabFromPath("/voice")).toBe("settings");
  });

  it("maps advanced sub-tabs", () => {
    expect(tabFromPath("/advanced")).toBe("advanced");
    expect(tabFromPath("/plugins")).toBe("plugins");
    expect(tabFromPath("/skills")).toBe("skills");
    expect(tabFromPath("/actions")).toBe("actions");
    expect(tabFromPath("/triggers")).toBe("triggers");
    expect(tabFromPath("/fine-tuning")).toBe("fine-tuning");
    expect(tabFromPath("/trajectories")).toBe("trajectories");
    expect(tabFromPath("/lifo")).toBe("lifo");
    expect(tabFromPath("/runtime")).toBe("runtime");
    expect(tabFromPath("/database")).toBe("database");
    expect(tabFromPath("/logs")).toBe("logs");
    expect(tabFromPath("/security")).toBe("security");
  });

  it("maps legacy paths", () => {
    expect(tabFromPath("/game")).toBe(APPS_ENABLED ? "apps" : "chat");
    expect(tabFromPath("/agent")).toBe("character");
    expect(tabFromPath("/inventory")).toBe("wallets");
    expect(tabFromPath("/features")).toBe("plugins");
    expect(tabFromPath("/admin")).toBe("advanced");
    expect(tabFromPath("/config")).toBe("settings");
  });

  it("is case-insensitive for current paths", () => {
    expect(tabFromPath("/ADVANCED")).toBe("advanced");
    expect(tabFromPath("/Skills")).toBe("skills");
  });

  it("returns null for unknown paths", () => {
    expect(tabFromPath("/workflows")).toBeNull();
    expect(tabFromPath("/nonexistent")).toBeNull();
  });
});

describe("pathForTab", () => {
  const roundTripTabs: Tab[] = [
    "chat",
    "companion",
    "stream",
    "character",
    "character-select",
    "wallets",
    "knowledge",
    "connectors",
    "plugins",
    "skills",
    "actions",
    "triggers",
    "advanced",
    "fine-tuning",
    "trajectories",
    "lifo",
    "runtime",
    "database",
    "settings",
    "logs",
    "security",
  ];
  if (APPS_ENABLED) {
    roundTripTabs.splice(3, 0, "apps");
  }

  it("round-trips every routed tab through tabFromPath", () => {
    for (const tab of roundTripTabs) {
      const path = pathForTab(tab);
      expect(tabFromPath(path), `${tab} -> ${path}`).toBe(tab);
    }
  });

  it("applies basePath prefixes", () => {
    expect(pathForTab("chat", "/app")).toBe("/app/chat");
    expect(pathForTab("actions", "/app")).toBe("/app/actions");
  });
});

describe("tab groups", () => {
  it("removes Character from the top-level navigation groups", () => {
    expect(ALL_TAB_GROUPS.map((group) => group.label)).not.toContain(
      "Character",
    );
    expect(getTabGroups(false).map((group) => group.label)).not.toContain(
      "Character",
    );
  });

  it("promotes heartbeats to a top-level group and keeps advanced tools grouped together", () => {
    const settings = ALL_TAB_GROUPS.find((group) => group.label === "Settings");
    expect(settings?.tabs).toEqual(["settings"]);

    const heartbeats = ALL_TAB_GROUPS.find(
      (group) => group.label === "Heartbeats",
    );
    expect(heartbeats?.tabs).toEqual(["triggers"]);

    const advanced = ALL_TAB_GROUPS.find((group) => group.label === "Advanced");
    expect(advanced?.tabs).toEqual([
      "advanced",
      "plugins",
      "skills",
      "actions",
      "fine-tuning",
      "trajectories",
      "lifo",
      "runtime",
      "database",
      "logs",
      "security",
    ]);
  });

  it("keeps every supported tab in at least one group", () => {
    const groupedTabs = new Set(ALL_TAB_GROUPS.flatMap((group) => group.tabs));
    const expectedTabs: Tab[] = [
      "chat",
      "stream",
      "apps",
      "wallets",
      "knowledge",
      "connectors",
      "plugins",
      "skills",
      "actions",
      "triggers",
      "advanced",
      "fine-tuning",
      "trajectories",
      "lifo",
      "runtime",
      "database",
      "logs",
      "security",
      "settings",
    ];

    for (const tab of expectedTabs) {
      expect(groupedTabs.has(tab), `missing group for ${tab}`).toBe(true);
    }
  });

  it("drops the stream group when stream is disabled", () => {
    expect(getTabGroups(false).map((group) => group.label)).not.toContain(
      "Stream",
    );
    expect(getTabGroups(true).map((group) => group.label)).toContain("Stream");
  });

  it("shows Heartbeats in the visible top-level groups", () => {
    expect(getTabGroups(false).map((group) => group.label)).toContain(
      "Heartbeats",
    );
  });
});

describe("titleForTab", () => {
  it("returns human-friendly titles for representative tabs", () => {
    expect(titleForTab("chat")).toBe("Chat");
    expect(titleForTab("actions")).toBe("Actions");
    expect(titleForTab("advanced")).toBe("Advanced");
    expect(titleForTab("stream")).toBe("Stream");
    expect(titleForTab("database")).toBe("Databases");
  });
});

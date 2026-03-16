import {
  ALL_TAB_GROUPS,
  APPS_ENABLED,
  pathForTab,
  tabFromPath,
  titleForTab,
} from "@elizaos/app-core/navigation";
import { describe, expect, test } from "vitest";

describe("navigation", () => {
  test("resolves path and title for advanced tabs and triggers", () => {
    expect(pathForTab("advanced")).toBe("/advanced");
    expect(tabFromPath("/advanced")).toBe("advanced");
    expect(titleForTab("advanced")).toBe("Advanced");

    expect(pathForTab("trajectories")).toBe("/trajectories");
    expect(tabFromPath("/trajectories")).toBe("trajectories");
    expect(titleForTab("trajectories")).toBe("Trajectories");

    expect(pathForTab("voice")).toBe("/voice");
    expect(tabFromPath("/voice")).toBe("settings");
    expect(titleForTab("voice")).toBe("Voice");

    expect(pathForTab("runtime")).toBe("/runtime");
    expect(tabFromPath("/runtime")).toBe("runtime");
    expect(titleForTab("runtime")).toBe("Runtime");

    expect(pathForTab("fine-tuning")).toBe("/fine-tuning");
    expect(tabFromPath("/fine-tuning")).toBe("fine-tuning");
    expect(titleForTab("fine-tuning")).toBe("Fine-Tuning");

    expect(pathForTab("triggers")).toBe("/triggers");
    expect(tabFromPath("/triggers")).toBe("triggers");
    expect(titleForTab("triggers")).toBe("Heartbeats");
  });

  test("promotes heartbeats to a top-level group and keeps other tools in Advanced", () => {
    const settings = ALL_TAB_GROUPS.find((group) => group.label === "Settings");
    expect(settings).toBeDefined();
    expect(settings?.tabs).toEqual(["settings"]);

    const heartbeats = ALL_TAB_GROUPS.find(
      (group) => group.label === "Heartbeats",
    );
    expect(heartbeats).toBeDefined();
    expect(heartbeats?.tabs).toEqual(["triggers"]);

    const advanced = ALL_TAB_GROUPS.find((group) => group.label === "Advanced");
    expect(advanced).toBeDefined();
    expect(advanced?.tabs.includes("advanced")).toBe(true);
    expect(advanced?.tabs.includes("plugins")).toBe(true);
    expect(advanced?.tabs.includes("skills")).toBe(true);
    expect(advanced?.tabs.includes("actions")).toBe(true);
    expect(advanced?.tabs.includes("triggers")).toBe(false);
    expect(advanced?.tabs.includes("fine-tuning")).toBe(true);
    expect(advanced?.tabs.includes("trajectories")).toBe(true);
    expect(advanced?.tabs.includes("runtime")).toBe(true);
    expect(advanced?.tabs.includes("database")).toBe(true);
    expect(advanced?.tabs.includes("logs")).toBe(true);
  });

  test("hides Voice from top-level header groups", () => {
    const voice = ALL_TAB_GROUPS.find((group) => group.label === "Voice");
    expect(voice).toBeUndefined();
  });

  test("keeps /game as a legacy redirect to apps", () => {
    expect(tabFromPath("/game")).toBe(APPS_ENABLED ? "apps" : "chat");
  });

  test("keeps /agent as a legacy redirect to character", () => {
    expect(tabFromPath("/agent")).toBe("character");
  });

  test("routes /connectors to connectors tab", () => {
    expect(pathForTab("connectors")).toBe("/connectors");
    expect(tabFromPath("/connectors")).toBe("connectors");
    expect(titleForTab("connectors")).toBe("Connectors");
  });

  test("routes /wallets and keeps legacy /inventory redirect", () => {
    expect(pathForTab("wallets")).toBe("/wallets");
    expect(tabFromPath("/wallets")).toBe("wallets");
    expect(tabFromPath("/inventory")).toBe("wallets");
    expect(titleForTab("wallets")).toBe("Wallets");
  });

  test("does not expose game as a top-level apps tab", () => {
    const apps = ALL_TAB_GROUPS.find((group) => group.label === "Apps");
    expect(apps).toBeDefined();
    expect(apps?.tabs).toEqual(["apps"]);
  });

  test("keeps wallets/knowledge/connectors as top-level groups, removes character from the nav, and adds heartbeats to the main nav", () => {
    const labels = ALL_TAB_GROUPS.map((group) => group.label);
    expect(labels).not.toContain("Character");
    expect(labels).toContain("Wallets");
    expect(labels).toContain("Knowledge");
    expect(labels).toContain("Connectors");
    expect(labels).toContain("Heartbeats");
    expect(labels).not.toContain("Tasks");
    expect(labels).not.toContain("Triggers");
    const settings = ALL_TAB_GROUPS.find((group) => group.label === "Settings");
    expect(settings?.tabs).toEqual(["settings"]);
    const heartbeats = ALL_TAB_GROUPS.find(
      (group) => group.label === "Heartbeats",
    );
    expect(heartbeats?.tabs).toEqual(["triggers"]);
    const advanced = ALL_TAB_GROUPS.find((group) => group.label === "Advanced");
    expect(advanced?.tabs.includes("triggers")).toBe(false);
    expect(labels).not.toContain("Agent");
  });
});

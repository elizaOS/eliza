import { describe, expect, it } from "vitest";
import {
  buildApplicationMenu,
  EMPTY_HEARTBEAT_MENU_SNAPSHOT,
} from "./application-menu";
import { getBrandConfig } from "./brand-config";

const baseArgs = {
  browserEnabled: false,
  heartbeatSnapshot: EMPTY_HEARTBEAT_MENU_SNAPSHOT,
  detachedWindows: [],
  agentReady: false,
};

function getMenuItems(isMac: boolean, label: string) {
  const menu = buildApplicationMenu({ ...baseArgs, isMac });
  const menuItem = menu.find((m) => m.label === label);
  if (!menuItem?.submenu) {
    throw new Error(`Expected ${label} menu to have submenu items`);
  }
  return menuItem.submenu;
}

function getAppMenuItems(isMac: boolean) {
  const menu = buildApplicationMenu({ ...baseArgs, isMac });
  const appMenu = menu[0];
  if (!appMenu?.submenu) {
    throw new Error("Expected app menu to have submenu items");
  }
  return appMenu.submenu;
}

function getRoleNames(items: ReturnType<typeof getMenuItems>): string[] {
  return items.flatMap((item) =>
    typeof item.role === "string" ? [item.role] : [],
  );
}

describe("buildApplicationMenu - Edit menu accelerators", () => {
  it("uses Ctrl+ shortcuts on Windows/Linux (isMac=false)", () => {
    const sub = getMenuItems(false, "Edit");
    expect(sub.find((i) => i.role === "cut")?.accelerator).toBe("Ctrl+X");
    expect(sub.find((i) => i.role === "copy")?.accelerator).toBe("Ctrl+C");
    expect(sub.find((i) => i.role === "paste")?.accelerator).toBe("Ctrl+V");
    expect(sub.find((i) => i.role === "selectAll")?.accelerator).toBe("Ctrl+A");
    expect(sub.find((i) => i.role === "undo")?.accelerator).toBe("Ctrl+Z");
    expect(sub.find((i) => i.role === "redo")?.accelerator).toBe("Ctrl+Y");
  });

  it("uses Command+ shortcuts on macOS (isMac=true)", () => {
    const sub = getMenuItems(true, "Edit");
    expect(sub.find((i) => i.role === "cut")?.accelerator).toBe("Command+X");
    expect(sub.find((i) => i.role === "copy")?.accelerator).toBe("Command+C");
    expect(sub.find((i) => i.role === "paste")?.accelerator).toBe("Command+V");
    expect(sub.find((i) => i.role === "selectAll")?.accelerator).toBe(
      "Command+A",
    );
    expect(sub.find((i) => i.role === "undo")?.accelerator).toBe("Command+Z");
    expect(sub.find((i) => i.role === "redo")?.accelerator).toBe(
      "Shift+Command+Z",
    );
  });
});

describe("buildApplicationMenu - app and window lifecycle accelerators", () => {
  it("wires macOS quit and close-window shortcuts explicitly", () => {
    const appName = getBrandConfig().appName;
    const appItems = getAppMenuItems(true);
    const quitItem = appItems.find((i) => i.role === "quit");
    expect(quitItem?.label).toBe(`Quit ${appName}`);
    expect(quitItem?.accelerator).toBe("Command+Q");

    const windowItems = getMenuItems(true, "Window");
    const closeItem = windowItems.find((i) => i.role === "close");
    expect(closeItem?.label).toBe("Close Window");
    expect(closeItem?.accelerator).toBe("Command+W");

    const cycleItem = windowItems.find((i) => i.role === "cycleThroughWindows");
    expect(cycleItem?.accelerator).toBe("Control+F4");
  });

  it("wires Windows/Linux quit and close-window shortcuts explicitly", () => {
    const appName = getBrandConfig().appName;
    const appItems = getAppMenuItems(false);
    const quitItem = appItems.find((i) => i.action === "quit");
    expect(quitItem?.label).toBe(`Quit ${appName}`);
    expect(quitItem?.accelerator).toBe("Ctrl+Q");

    const windowItems = getMenuItems(false, "Window");
    const closeItem = windowItems.find((i) => i.role === "close");
    expect(closeItem?.label).toBe("Close Window");
    expect(closeItem?.accelerator).toBe("Ctrl+F4");
  });
});

describe("buildApplicationMenu - Electrobun-native roles", () => {
  it("uses Electrobun role names for macOS app and window commands", () => {
    const appRoles = getRoleNames(getAppMenuItems(true));
    expect(appRoles).toContain("showAll");
    expect(appRoles).not.toContain("unhide");

    const viewRoles = getRoleNames(getMenuItems(true, "View"));
    expect(viewRoles).toContain("toggleFullScreen");
    expect(viewRoles).not.toContain("togglefullscreen");

    const windowRoles = getRoleNames(getMenuItems(true, "Window"));
    expect(windowRoles).toContain("bringAllToFront");
    expect(windowRoles).not.toContain("front");
  });
});

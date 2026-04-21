import { describe, expect, it } from "vitest";
import {
  EMPTY_HEARTBEAT_MENU_SNAPSHOT,
  buildApplicationMenu,
} from "./application-menu";

const baseArgs = {
  browserEnabled: false,
  heartbeatSnapshot: EMPTY_HEARTBEAT_MENU_SNAPSHOT,
  detachedWindows: [],
  agentReady: false,
} as const;

function getEditMenu(isMac: boolean) {
  const menu = buildApplicationMenu({ ...baseArgs, isMac });
  return menu.find((m) => m.label === "Edit");
}

describe("buildApplicationMenu - Edit menu accelerators", () => {
  it("uses Ctrl+ shortcuts on Windows/Linux (isMac=false)", () => {
    const editMenu = getEditMenu(false);
    expect(editMenu).toBeDefined();
    const sub = editMenu!.submenu!;
    expect(sub.find((i) => i.role === "cut")?.accelerator).toBe("Ctrl+X");
    expect(sub.find((i) => i.role === "copy")?.accelerator).toBe("Ctrl+C");
    expect(sub.find((i) => i.role === "paste")?.accelerator).toBe("Ctrl+V");
    expect(sub.find((i) => i.role === "selectAll")?.accelerator).toBe("Ctrl+A");
    expect(sub.find((i) => i.role === "undo")?.accelerator).toBe("Ctrl+Z");
    expect(sub.find((i) => i.role === "redo")?.accelerator).toBe("Ctrl+Y");
  });

  it("uses Command+ shortcuts on macOS (isMac=true)", () => {
    const editMenu = getEditMenu(true);
    expect(editMenu).toBeDefined();
    const sub = editMenu!.submenu!;
    expect(sub.find((i) => i.role === "cut")?.accelerator).toBe("Command+X");
    expect(sub.find((i) => i.role === "copy")?.accelerator).toBe("Command+C");
    expect(sub.find((i) => i.role === "paste")?.accelerator).toBe("Command+V");
    expect(sub.find((i) => i.role === "selectAll")?.accelerator).toBe("Command+A");
    expect(sub.find((i) => i.role === "undo")?.accelerator).toBe("Command+Z");
    expect(sub.find((i) => i.role === "redo")?.accelerator).toBe("Shift+Command+Z");
  });
});

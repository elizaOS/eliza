/** Verifies that signed native clients receive the canonical Calendar page. */

import { listAppShellPages } from "@elizaos/ui/app-shell-registry";
import { describe, expect, it } from "vitest";
import "./register.ts";

describe("Calendar app registration", () => {
  it("matches the runtime route and targets the canonical Calendar component", () => {
    const pages = listAppShellPages().filter(
      (page) => page.pluginId === "@elizaos/plugin-calendar",
    );

    expect(
      pages.map(({ id, label, path, viewKind }) => ({
        id,
        label,
        path,
        viewKind,
      })),
    ).toEqual([
      {
        id: "calendar",
        label: "Calendar",
        path: "/calendar",
        viewKind: "release",
      },
    ]);
    expect(pages[0]?.loader).toBeTypeOf("function");
    expect(pages[0]?.surface).toEqual({
      header: "fullscreen",
      capabilities: ["agent-surface"],
    });
    expect(String(pages[0]?.loader)).toContain("SimpleCalendarView");
  });
});

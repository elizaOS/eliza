/** Verifies that signed native clients receive the canonical Calendar page. */

import { listAppShellPages } from "@elizaos/ui/app-shell-registry";
import { describe, expect, it } from "vitest";
import { SimpleCalendarView } from "./components/calendar/SimpleCalendarView.tsx";
import "./register.ts";

describe("Calendar app registration", () => {
  it("matches the runtime route and targets the canonical Calendar component", async () => {
    const pages = listAppShellPages().filter(
      (page) => page.pluginId === "@elizaos/plugin-calendar",
    );

    expect(
      pages.map(({ id, label, icon, path, viewKind }) => ({
        id,
        label,
        icon,
        path,
        viewKind,
      })),
    ).toEqual([
      {
        id: "calendar",
        label: "Calendar",
        icon: expect.any(String),
        path: "/calendar",
        viewKind: "release",
      },
    ]);
    expect(pages[0]?.loader).toBeTypeOf("function");
    expect(pages[0]?.surface).toEqual({
      header: "fullscreen",
      capabilities: ["agent-surface"],
    });
    const loaded = await pages[0]?.loader?.();
    expect(loaded?.default).toBe(SimpleCalendarView);
  });
});

/** Verifies signed native clients receive all task-coordinator GUI routes. */

import { listAppShellPages } from "@elizaos/ui/app-shell-registry";
import { describe, expect, it, vi } from "vitest";

vi.mock("./register-slots.js", () => ({}));

import "./register.ts";

describe("Task coordinator app registration", () => {
  it("matches the runtime manifests and grants the signed surface contract", () => {
    const pages = listAppShellPages().filter(
      (page) => page.pluginId === "@elizaos/plugin-task-coordinator",
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
        id: "task-coordinator",
        label: "Task Coordinator",
        path: "/task-coordinator",
        viewKind: "preview",
      },
      {
        id: "orchestrator",
        label: "Orchestrator",
        path: "/orchestrator",
        viewKind: "developer",
      },
      {
        id: "cockpit",
        label: "Cockpit",
        path: "/cockpit",
        viewKind: "developer",
      },
    ]);
    for (const page of pages) {
      expect(page.loader).toBeTypeOf("function");
      expect(page.surface).toEqual({
        header: "fullscreen",
        capabilities: ["agent-surface"],
      });
    }
  });
});

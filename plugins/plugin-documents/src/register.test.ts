/** Verifies the signed app-shell registration for the plugin-owned Knowledge view. */

import { listAppShellPages } from "@elizaos/ui/app-shell-registry";
import { describe, expect, it } from "vitest";
import "./register.ts";

describe("Knowledge app registration", () => {
  it("registers the document route with a lazy local renderer", () => {
    const pages = listAppShellPages().filter(
      (page) => page.pluginId === "@elizaos/plugin-documents",
    );

    expect(
      pages.map(({ id, label, path, pathPatterns, viewKind }) => ({
        id,
        label,
        path,
        pathPatterns,
        viewKind,
      })),
    ).toEqual([
      {
        id: "documents",
        label: "Knowledge",
        path: "/documents",
        pathPatterns: ["/character/documents"],
        viewKind: "system",
      },
    ]);
    expect(pages[0]?.loader).toBeTypeOf("function");
    expect(pages[0]?.surface).toEqual({
      header: "fullscreen",
      capabilities: ["agent-surface"],
    });
  });
});

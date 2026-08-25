/**
 * Verifies the signed app bundle receives the static Notes renderer.
 */

import { listAppShellPages } from "@elizaos/ui/app-shell-registry";
import { describe, expect, it } from "vitest";
import "./register.ts";

describe("Notes app registration", () => {
  it("registers release pages that match the runtime manifests", () => {
    const pages = listAppShellPages().filter(
      (page) => page.pluginId === "@elizaos/plugin-notes",
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
        id: "notes",
        label: "Notes",
        path: "/notes",
        viewKind: "release",
      },
    ]);
    for (const page of pages) {
      expect(page.loader).toBeTypeOf("function");
      expect(page.surface).toEqual({ header: "fullscreen" });
    }
  });
});

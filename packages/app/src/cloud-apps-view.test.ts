/**
 * Native Cloud Apps destination registration against the real app-shell registry.
 */

import { listAppShellPages } from "@elizaos/ui/app-shell-registry";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/platform", () => ({
  getFrontendPlatform: () => "ios",
}));

beforeAll(async () => {
  await import("./cloud-apps-view");
});

describe("Cloud Apps native destination", () => {
  it("registers a bundled app-shell page at the path emitted by VIEWS", () => {
    const page = listAppShellPages().find((entry) => entry.id === "cloud-apps");

    expect(page).toMatchObject({
      id: "cloud-apps",
      pluginId: "@elizaos/app",
      label: "Cloud Apps",
      path: "/cloud-apps",
    });
    expect(page?.loader).toBeTypeOf("function");
  });
});

/** Verifies the bundled Cloud route family declares only its required shell capability. */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listAppShellPages } from "../app-shell-registry";
import { resetUiRegistryHostForTests } from "../registry-host";

describe("managed Cloud app-shell registration", () => {
  beforeEach(() => {
    resetUiRegistryHostForTests();
    vi.resetModules();
  });

  it("grants nested route navigation without widening storage or wallpaper authority", async () => {
    const { registerManagedCloudAppShellPage } = await import(
      "./register-managed-cloud-page"
    );

    registerManagedCloudAppShellPage();

    const registration = listAppShellPages().find(
      (entry) => entry.id === "cloud",
    );
    expect(registration?.path).toBe("/cloud");
    expect(registration?.pathPatterns).toEqual(["/cloud/*"]);
    expect(registration?.surface).toEqual({ capabilities: ["navigate"] });
  });
});

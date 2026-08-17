/** Proves the packaged desktop boot-config API base reaches branding before React mounts. */

import { describe, expect, it } from "vitest";
import { resolveInjectedAppApiBase } from "./injected-app-api-base";

describe("resolveInjectedAppApiBase", () => {
  it("uses the packaged boot-config base when legacy globals are absent", () => {
    expect(
      resolveInjectedAppApiBase({
        bootApiBase: "http://127.0.0.1:31337",
      }),
    ).toBe("http://127.0.0.1:31337");
  });

  it("preserves legacy host precedence during migration", () => {
    expect(
      resolveInjectedAppApiBase({
        legacyApiBase: "http://127.0.0.1:31338",
        brandedApiBase: "http://127.0.0.1:31339",
        bootApiBase: "http://127.0.0.1:31337",
      }),
    ).toBe("http://127.0.0.1:31338");
  });

  it("ignores empty or non-string candidates", () => {
    expect(
      resolveInjectedAppApiBase({
        brandedApiBase: 31337,
        bootApiBase: "  ",
      }),
    ).toBeUndefined();
  });
});

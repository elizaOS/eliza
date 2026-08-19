/** Verifies deterministic pre-React desktop API-base selection without a host runtime. */

import { describe, expect, it } from "vitest";
import { resolveInjectedAppApiBase } from "./app-config";

describe("resolveInjectedAppApiBase", () => {
  it("uses the canonical injected boot config for packaged local desktop", () => {
    expect(
      resolveInjectedAppApiBase({
        bootConfigApiBase: "http://127.0.0.1:32437",
      }),
    ).toBe("http://127.0.0.1:32437");
  });

  it("keeps legacy host globals as compatibility fallbacks", () => {
    expect(
      resolveInjectedAppApiBase({
        legacyApiBase: "https://legacy.example",
        brandedApiBase: "https://brand.example",
      }),
    ).toBe("https://legacy.example");
    expect(
      resolveInjectedAppApiBase({
        brandedApiBase: "https://brand.example",
      }),
    ).toBe("https://brand.example");
  });

  it("prefers canonical boot config over compatibility globals", () => {
    expect(
      resolveInjectedAppApiBase({
        bootConfigApiBase: "http://127.0.0.1:32437",
        legacyApiBase: "https://legacy.example",
        brandedApiBase: "https://brand.example",
      }),
    ).toBe("http://127.0.0.1:32437");
  });
});

import { describe, expect, it } from "vitest";
import { resolveAppHeroImage } from "./registry-client-queries.js";

describe("resolveAppHeroImage", () => {
  it("routes relative hero assets through the app hero endpoint", () => {
    expect(
      resolveAppHeroImage("@elizaos/app-companion", "assets/hero.png"),
    ).toBe("/api/apps/hero/companion");
  });

  it("returns a generated hero route when an app declares no hero asset", () => {
    expect(resolveAppHeroImage("@acme/app-mystery", null)).toBe(
      "/api/apps/hero/mystery",
    );
  });

  it("preserves already absolute hero image URLs", () => {
    expect(
      resolveAppHeroImage("@acme/app-mystery", "/app-heroes/mystery.png"),
    ).toBe("/app-heroes/mystery.png");
  });
});

// @vitest-environment jsdom
//
// Verifies the web fallback rejects every method: a web host has no native child
// surface, so an accidental call must fail loudly rather than return a surface
// that isolates nothing. Real WebPlugin instance, no mocks.

import { describe, expect, it } from "vitest";
import { BrowserSurfaceWeb } from "./web";

describe("BrowserSurfaceWeb", () => {
  const web = new BrowserSurfaceWeb();

  it("rejects createSurface even with a full explicit policy", async () => {
    await expect(
      web.createSurface({
        id: "browser-tab:a",
        url: "https://example.com",
        process: "isolated",
        storage: "isolated",
      }),
    ).rejects.toThrow(/native-only/i);
  });

  it("rejects every surface method as unavailable", async () => {
    await expect(
      web.setBounds({ id: "a", x: 0, y: 0, width: 1, height: 1 }),
    ).rejects.toThrow(/native-only/i);
    await expect(
      web.navigate({ id: "a", url: "https://example.com" }),
    ).rejects.toThrow(/native-only/i);
    await expect(web.foregroundSurface({ id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.backgroundSurface({ id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.destroySurface({ id: "a" })).rejects.toThrow(
      /native-only/i,
    );
    await expect(web.foregroundHost()).rejects.toThrow(/native-only/i);
    await expect(web.getSurfaceState({ id: "a" })).rejects.toThrow(
      /native-only/i,
    );
  });
});

// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { getProviderLogo } from "./provider-logos";

describe("provider logos", () => {
  it("selects themed assets and preserves provider aliases", () => {
    expect(getProviderLogo("OPENAI")).toMatch(/logos\/openai-icon-white\.png$/);
    expect(getProviderLogo("openai", false)).toMatch(
      /logos\/openai-icon\.png$/,
    );
    for (const [alias, owner] of [
      ["grok", "xai"],
      ["gemini", "google"],
      ["together-ai", "together"],
      ["z.ai", "zai"],
    ]) {
      expect(getProviderLogo(alias)).toBe(getProviderLogo(owner));
      expect(getProviderLogo(alias, false)).toBe(getProviderLogo(owner, false));
    }
    expect(getProviderLogo("anthropic-subscription")).toMatch(
      /logos\/claude-icon\.png$/,
    );
  });

  it("gives the host's theme-specific asset precedence", () => {
    const custom = {
      logoDark: "https://example.com/dark.svg",
      logoLight: "https://example.com/light.svg",
    };
    expect(getProviderLogo("openai", true, custom)).toBe(custom.logoDark);
    expect(getProviderLogo("openai", false, custom)).toBe(custom.logoLight);
    expect(
      getProviderLogo("openai", false, { logoDark: custom.logoDark }),
    ).toMatch(/logos\/openai-icon\.png$/);
  });

  it.each(["", "<&", "#%", "constructor", "__proto__", "💡x"])(
    "renders a valid fallback SVG for %j",
    (id) => {
      const url = getProviderLogo(id);
      expect(url).toMatch(/^data:image\/svg\+xml,/);
      const svg = new DOMParser().parseFromString(
        decodeURIComponent(url.split(",")[1]),
        "image/svg+xml",
      );
      expect(svg.querySelector("parsererror")).toBeNull();
      expect(svg.querySelector("text")?.textContent).toBe(
        Array.from(id).slice(0, 2).join("").toUpperCase(),
      );
      expect(svg.querySelector("rect")?.getAttribute("fill")).toMatch(
        /^#[\da-f]{6}$/,
      );
    },
  );
});

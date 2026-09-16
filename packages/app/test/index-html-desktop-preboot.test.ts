/** Exercises the parser-time desktop launch surface before React mounts. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "..");
const indexHtml = readFileSync(join(appRoot, "index.html"), "utf8");

function parseDesktopSurface(search: string): JSDOM {
  return new JSDOM(indexHtml, {
    pretendToBeVisual: true,
    runScripts: "dangerously",
    url: `https://localhost/${search}`,
  });
}

describe("index.html desktop preboot surfaces", () => {
  it.each(["shellMode", "shell-mode"])(
    "makes the chat overlay transparent and removes branded loading via %s",
    (shellModeKey) => {
      const dom = parseDesktopSurface(
        `?${shellModeKey}=chat-overlay&desktopSurface=chat-overlay`,
      );
      const { document } = dom.window;

      expect(
        document.documentElement.getAttribute("data-chat-overlay-preboot"),
      ).toBe("true");
      expect(
        document.documentElement.style.getPropertyValue("--launch-bg"),
      ).toBe("transparent");
      expect(document.getElementById("eliza-preboot-shell")).toBeNull();
      const parsedShellProbe = document.createElement("div");
      parsedShellProbe.className = "eliza-preboot-shell";
      document.body.appendChild(parsedShellProbe);
      expect(dom.window.getComputedStyle(parsedShellProbe).display).toBe(
        "none",
      );
      for (const surface of [
        document.documentElement,
        document.body,
        document.getElementById("root"),
      ]) {
        expect(surface).not.toBeNull();
        expect(
          dom.window.getComputedStyle(surface as Element).backgroundColor,
        ).toBe("rgba(0, 0, 0, 0)");
      }

      dom.window.close();
    },
  );

  it.each(["workspace", "settings"])(
    "uses the managed neutral canvas and no branded loader for %s",
    (desktopSurface) => {
      const dom = parseDesktopSurface(`?desktopSurface=${desktopSurface}`);
      const { document } = dom.window;

      expect(
        document.documentElement.getAttribute("data-desktop-managed-preboot"),
      ).toBe("true");
      expect(
        document.documentElement.style.getPropertyValue("--launch-bg"),
      ).toBe("#181a20");
      expect(
        document.documentElement.style.getPropertyValue("--launch-foreground"),
      ).toBe("#f4f5f7");
      expect(document.getElementById("eliza-preboot-shell")).toBeNull();

      dom.window.close();
    },
  );

  it("keeps the branded preboot shell for the ordinary app surface", () => {
    const dom = parseDesktopSurface("");
    const { document } = dom.window;

    expect(
      document.documentElement.hasAttribute("data-chat-overlay-preboot"),
    ).toBe(false);
    expect(
      document.documentElement.hasAttribute("data-desktop-managed-preboot"),
    ).toBe(false);
    expect(document.getElementById("eliza-preboot-shell")).not.toBeNull();

    dom.window.close();
  });
});

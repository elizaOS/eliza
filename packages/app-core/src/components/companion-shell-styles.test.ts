import type { Tab } from "@elizaos/app-core/navigation";
import { describe, expect, it } from "vitest";
import {
  ACCENT_COLORS,
  accentForegroundVar,
  accentSubtleVar,
  accentVar,
  COMPANION_OVERLAY_TABS,
  cardSizeClass,
  overlayBackdropClass,
  TOP_BAR_COLORS,
  tabFlags,
  viewWrapperStyle,
} from "./companion-shell-styles";

describe("COMPANION_OVERLAY_TABS", () => {
  it("contains only companion — settings/character/skills etc. require native mode", () => {
    expect(COMPANION_OVERLAY_TABS.has("companion")).toBe(true);
  });

  it("does not treat other tabs as companion overlay", () => {
    expect(COMPANION_OVERLAY_TABS.has("chat")).toBe(false);
    expect(COMPANION_OVERLAY_TABS.has("settings")).toBe(false);
    expect(COMPANION_OVERLAY_TABS.has("skills")).toBe(false);
  });
});

describe("tabFlags", () => {
  const advancedOverlayTabs: Tab[] = [
    "advanced",
    "actions",
    "fine-tuning",
    "trajectories",
    "runtime",
    "database",
    "logs",
    "security",
  ];

  for (const tab of advancedOverlayTabs) {
    it(`${tab} is an advanced overlay`, () => {
      expect(tabFlags(tab).isAdvancedOverlay).toBe(true);
      expect(tabFlags(tab).isCentered).toBe(true);
    });
  }

  it("keeps non-advanced tabs out of the advanced overlay bucket", () => {
    expect(tabFlags("chat").isAdvancedOverlay).toBe(false);
    expect(tabFlags("stream").isAdvancedOverlay).toBe(false);
    expect(tabFlags("triggers").isAdvancedOverlay).toBe(false);
    expect(tabFlags("wallets").isAdvancedOverlay).toBe(false);
    expect(tabFlags("settings").isAdvancedOverlay).toBe(false);
    expect(tabFlags("knowledge").isAdvancedOverlay).toBe(false);
  });

  it("treats triggers as a settings-style layout", () => {
    expect(tabFlags("triggers").isSettings).toBe(true);
    expect(tabFlags("triggers").isCentered).toBe(true);
  });

  it("reports individual flags consistently", () => {
    expect(tabFlags("skills").isSkills).toBe(true);
    expect(tabFlags("stream").isStream).toBe(true);
    expect(tabFlags("wallets").isWallets).toBe(true);
    expect(tabFlags("character").isCharacter).toBe(true);
    expect(tabFlags("character-select").isCharacter).toBe(true);
    expect(tabFlags("actions").isSkills).toBe(false);
    expect(tabFlags("actions").isStream).toBe(false);
    expect(tabFlags("actions").isCharacter).toBe(false);
    expect(tabFlags("actions").isWallets).toBe(false);
  });
});

describe("derived style helpers", () => {
  it("gives advanced overlays the large centered card layout", () => {
    const classes = cardSizeClass(tabFlags("actions"));
    expect(classes).toContain("w-[95vw]");
    expect(classes).toContain("h-[95vh]");
    expect(classes).toContain("rounded-2xl");
    expect(classes).toContain("overflow-hidden");
  });

  it("gives advanced overlays the dark blurred backdrop", () => {
    const classes = overlayBackdropClass(tabFlags("actions"));
    expect(classes).toContain("backdrop-blur-2xl");
    expect(classes).toContain("bg-black/50");
    expect(classes).toContain("pointer-events-auto");
  });

  it("keeps chat as the base view without backdrop", () => {
    expect(overlayBackdropClass(tabFlags("chat"))).toBe("opacity-0");
  });

  it("uses the default accent for generic advanced overlays", () => {
    const flags = tabFlags("actions");
    expect(accentVar(flags)).toBe("#7b8fb5");
    expect(accentSubtleVar(flags)).toBe("rgba(123, 143, 181, 0.12)");
  });

  it("keeps special-case accents for stream and wallets", () => {
    expect(accentVar(tabFlags("stream"))).toBe("#ef4444");
    expect(accentVar(tabFlags("wallets"))).toBe("#f0b90b");
  });

  it("keeps card surfaces non-transparent in base chat shell", () => {
    const style = viewWrapperStyle(tabFlags("chat"), "#7b8fb5");
    expect(style["--card"]).toBe("rgba(255, 255, 255, 0.05)");
  });

  it("uses dark accent foregrounds for yellow companion tabs", () => {
    expect(accentForegroundVar(tabFlags("wallets"))).toBe("#1a1f26");
    expect(accentForegroundVar(tabFlags("skills"))).toBe("#1a1f26");
    expect(accentForegroundVar(tabFlags("knowledge"))).toBe("#ffffff");
  });
});

describe("App.tsx advanced-tab parity", () => {
  const advancedParityTabs: Tab[] = [
    "advanced",
    "actions",
    "fine-tuning",
    "trajectories",
    "runtime",
    "database",
    "logs",
    "security",
  ];

  for (const tab of advancedParityTabs) {
    it(`${tab} stays aligned with the native-shell advanced layout contract`, () => {
      expect(tabFlags(tab).isAdvancedOverlay).toBe(true);
    });
  }
});

describe("accent palettes", () => {
  it("keeps stable accent constants", () => {
    expect(ACCENT_COLORS.stream).toBe("#ef4444");
    expect(ACCENT_COLORS.skills).toBe("#f0b232");
    expect(TOP_BAR_COLORS.stream).toContain("239, 68, 68");
  });
});

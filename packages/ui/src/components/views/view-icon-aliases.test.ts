// resolveViewIconId maps plugin/builtin view ids onto their nearest baked icon,
// passes through ids that resolve directly, and every alias target is verified
// against the real generated VIEW_ICONS map so no alias points at a missing icon.
import { describe, expect, it } from "vitest";
import { resolveViewIconId, VIEW_ICON_ALIASES } from "./view-icon-aliases";
import { VIEW_ICONS } from "./view-icons.generated";

describe("resolveViewIconId", () => {
  it("maps known plugin view ids to their nearest baked icon", () => {
    expect(resolveViewIconId("hyperliquid")).toBe("trade");
    expect(resolveViewIconId("shopify")).toBe("shop");
    expect(resolveViewIconId("smartglasses")).toBe("glasses");
    expect(resolveViewIconId("trajectory-logger")).toBe("trajectory");
    expect(resolveViewIconId("phone-companion")).toBe("companion");
  });

  it("passes through ids that have (or fall back from) their own icon", () => {
    expect(resolveViewIconId("chat")).toBe("chat");
    expect(resolveViewIconId("feed")).toBe("feed");
    expect(resolveViewIconId("an-unknown-view")).toBe("an-unknown-view");
  });

  it("every alias target is a real baked icon key (no alias points at a missing icon)", () => {
    for (const target of Object.values(VIEW_ICON_ALIASES)) {
      expect(
        VIEW_ICONS[target],
        `alias target "${target}" must be baked`,
      ).toBeTruthy();
    }
  });
});

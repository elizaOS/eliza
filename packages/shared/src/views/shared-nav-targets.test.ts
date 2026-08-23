/**
 * Coverage for shared-nav-targets.
 */
import { describe, expect, it } from "vitest";
import {
  DOCUMENTS_NAV_VOCABULARY,
  SHARED_NAV_TARGETS,
  SHARED_NAV_UI_LOCALES,
} from "./shared-nav-targets.js";

describe("shared-nav-targets", () => {
  it("exposes locales", () => {
    expect(SHARED_NAV_UI_LOCALES).toContain("en");
  });
  it("exposes documents vocab", () => {
    expect(DOCUMENTS_NAV_VOCABULARY.viewId).toBe("documents");
    expect(DOCUMENTS_NAV_VOCABULARY.aliases).toContain("knowledge base");
  });
  it("exposes targets", () => {
    expect(SHARED_NAV_TARGETS.settings.viewId).toBe("settings");
    expect(SHARED_NAV_TARGETS.wallet.viewId).toBe("inventory");
  });
});

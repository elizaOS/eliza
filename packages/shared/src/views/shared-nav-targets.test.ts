/**
 * Unit tests for shared-nav-targets: validates navigation vocabulary,
 * localized labels across UI locales, and view ID translation targets.
 */
import { describe, expect, it } from "vitest";
import {
  DOCUMENTS_NAV_VOCABULARY,
  SHARED_NAV_TARGETS,
  SHARED_NAV_UI_LOCALES,
} from "./shared-nav-targets.ts";

describe("shared-nav-targets", () => {
  it("maps standard navigation targets to routable view IDs", () => {
    expect(SHARED_NAV_TARGETS.settings.viewId).toBe("settings");
    expect(SHARED_NAV_TARGETS.vault.viewId).toBe("vault");
    expect(SHARED_NAV_TARGETS.wallet.viewId).toBe("inventory"); // translated
    expect(SHARED_NAV_TARGETS.calendar.viewId).toBe("calendar");
    expect(SHARED_NAV_TARGETS.inbox.viewId).toBe("inbox");
    expect(SHARED_NAV_TARGETS.finances.viewId).toBe("finances");
    expect(SHARED_NAV_TARGETS.chat.viewId).toBe("chat");
    expect(SHARED_NAV_TARGETS["cloud-apps"].viewPath).toBe("/cloud-apps");
  });

  it("omits native-only surfaces like camera from shared targets", () => {
    expect(SHARED_NAV_TARGETS.camera).toBeUndefined();
  });

  it("provides complete localized labels for documents vocabulary", () => {
    expect(DOCUMENTS_NAV_VOCABULARY.viewId).toBe("documents");
    expect(DOCUMENTS_NAV_VOCABULARY.label).toBe("Knowledge");
    expect(DOCUMENTS_NAV_VOCABULARY.aliases).toContain("knowledge base");

    for (const locale of SHARED_NAV_UI_LOCALES) {
      const label = DOCUMENTS_NAV_VOCABULARY.localizedLabels[locale];
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

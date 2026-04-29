/**
 * Pure unit tests for the page-scoped conversations helper. The full pane
 * + resolver round-trip is covered by the live e2e at
 * eliza/packages/app-core/test/live-agent/page-scoped-chat.live.e2e.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  buildPageScopedConversationMetadata,
  buildPageScopedRoutingMetadata,
  isPageScopedConversation,
  isPageScopedConversationMetadata,
  PAGE_SCOPE_COPY,
  PAGE_SCOPE_VERSION,
  PAGE_SCOPES,
} from "./page-scoped-conversations";

describe("page-scoped-conversations helper", () => {
  describe("predicates", () => {
    it("recognizes every page scope as page-scoped", () => {
      for (const scope of PAGE_SCOPES) {
        expect(
          isPageScopedConversationMetadata({ scope }),
          `${scope} should be page-scoped`,
        ).toBe(true);
        expect(
          isPageScopedConversation({ metadata: { scope } }),
          `${scope} should be page-scoped via conversation`,
        ).toBe(true);
      }
    });

    it("rejects automation and general scopes", () => {
      expect(
        isPageScopedConversationMetadata({ scope: "automation-workflow" }),
      ).toBe(false);
      expect(isPageScopedConversationMetadata({ scope: "general" })).toBe(
        false,
      );
      expect(isPageScopedConversationMetadata(undefined)).toBe(false);
      expect(isPageScopedConversationMetadata(null)).toBe(false);
      expect(isPageScopedConversation(null)).toBe(false);
    });
  });

  describe("buildPageScopedConversationMetadata", () => {
    it("produces minimal metadata with just the scope", () => {
      const metadata = buildPageScopedConversationMetadata("page-browser");
      expect(metadata).toEqual({ scope: "page-browser" });
    });

    it("includes pageId when provided", () => {
      const metadata = buildPageScopedConversationMetadata("page-character", {
        pageId: "char-123",
      });
      expect(metadata).toEqual({ scope: "page-character", pageId: "char-123" });
    });

    it("includes sourceConversationId when provided", () => {
      const metadata = buildPageScopedConversationMetadata("page-apps", {
        sourceConversationId: "conv-source",
      });
      expect(metadata).toEqual({
        scope: "page-apps",
        sourceConversationId: "conv-source",
      });
    });
  });

  describe("buildPageScopedRoutingMetadata — every sortable dimension stamped", () => {
    it("stamps taskId, surface, surfaceVersion + response context for every scope", () => {
      const expectedContext: Record<
        (typeof PAGE_SCOPES)[number],
        { primaryContext: string; secondaryContexts: string[] }
      > = {
        "page-browser": {
          primaryContext: "browser",
          secondaryContexts: ["page", "page-browser", "browser", "knowledge"],
        },
        "page-character": {
          primaryContext: "character",
          secondaryContexts: [
            "page",
            "page-character",
            "character",
            "knowledge",
            "social",
          ],
        },
        "page-automations": {
          primaryContext: "automation",
          secondaryContexts: ["page", "page-automations", "automation"],
        },
        "page-apps": {
          primaryContext: "apps",
          secondaryContexts: ["page", "page-apps", "apps"],
        },
        "page-connectors": {
          primaryContext: "connectors",
          secondaryContexts: [
            "page",
            "page-connectors",
            "connectors",
            "social",
          ],
        },
        "page-phone": {
          primaryContext: "phone",
          secondaryContexts: ["page", "page-phone", "phone", "social"],
        },
        "page-plugins": {
          primaryContext: "plugins",
          secondaryContexts: ["page", "page-plugins", "plugins", "system"],
        },
        "page-lifeops": {
          primaryContext: "lifeops",
          secondaryContexts: [
            "page",
            "page-lifeops",
            "lifeops",
            "automation",
            "social",
          ],
        },
        "page-settings": {
          primaryContext: "settings",
          secondaryContexts: ["page", "page-settings", "settings", "system"],
        },
        "page-wallet": {
          primaryContext: "wallet",
          secondaryContexts: ["page", "page-wallet", "wallet"],
        },
      };
      for (const scope of PAGE_SCOPES) {
        const meta = buildPageScopedRoutingMetadata(scope);
        expect(meta.taskId).toBe(scope);
        expect(meta.surface).toBe("page-scoped");
        expect(meta.surfaceVersion).toBe(PAGE_SCOPE_VERSION);
        expect(meta.__responseContext).toEqual(expectedContext[scope]);
      }
    });

    it("does not include pageId when not provided", () => {
      const meta = buildPageScopedRoutingMetadata("page-browser");
      expect(meta.pageId).toBeUndefined();
    });

    it("includes pageId and sourceConversationId when provided", () => {
      const meta = buildPageScopedRoutingMetadata("page-character", {
        pageId: "char-7",
        sourceConversationId: "main-1",
      });
      expect(meta.pageId).toBe("char-7");
      expect(meta.sourceConversationId).toBe("main-1");
    });
  });

  describe("PAGE_SCOPE_COPY", () => {
    it("provides title, body, and systemAddendum for every scope", () => {
      for (const scope of PAGE_SCOPES) {
        const copy = PAGE_SCOPE_COPY[scope];
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.body.length).toBeGreaterThan(0);
        expect(copy.body).toMatch(/Ask me|Use me|Install/);
        expect(copy.systemAddendum.length).toBeGreaterThan(0);
        expect(copy.systemAddendum.toLowerCase()).toContain("recommend");
      }
    });

    it("describes the redesigned Character hub sections explicitly", () => {
      const copy = PAGE_SCOPE_COPY["page-character"];

      for (const section of [
        "Overview",
        "Personality",
        "Knowledge",
        "Skills",
        "Experience",
        "Relationships",
      ]) {
        expect(copy.body).toContain(section);
        expect(copy.systemAddendum).toContain(section);
      }
    });
  });

  describe("PAGE_SCOPE_VERSION", () => {
    it("is a positive integer (bump it when copy/live-state shape changes)", () => {
      expect(Number.isInteger(PAGE_SCOPE_VERSION)).toBe(true);
      expect(PAGE_SCOPE_VERSION).toBeGreaterThan(0);
    });
  });
});

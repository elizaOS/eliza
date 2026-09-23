/**
 * Exercises aesthetic audit readiness against the real experience renderer and
 * memory taxonomy colors against the shipped stylesheet. HTTP fixtures supply
 * empty/populated records; components and the strict brand scanner remain real.
 */
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import {
  collectBlueColors,
  collectHoverViolations,
} from "./helpers/brand-color-scans";
import { seedStewardSession } from "./helpers/test-auth";
import { normalize, positiveExpectationMatches } from "./ocr-content-rules";
import { resolveViewOcrPolicy } from "./ocr-view-expectations";

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test.describe(viewport.name, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(viewport);
      await seedAppStorage(page);
      await seedStewardSession(page, { jwt: true });
      await installDefaultAppRoutes(page);
    });

    test("experience audit accepts real empty and populated states, not loading or navigation", async ({
      page,
    }, testInfo) => {
      const policy = resolveViewOcrPolicy("builtin-experience");
      if (policy.kind !== "expectation")
        throw new Error("Experience must declare semantics");
      const matches = (text: string) =>
        positiveExpectationMatches(normalize(text), policy.expectation);
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      let populated = false;
      await page.route("**/api/character/experiences?*", async (route) => {
        await held;
        const records = populated
          ? [
              {
                id: "audit-experience",
                type: "learning",
                outcome: "positive",
                context: "A request included two independent tasks",
                action: "Verify both outcomes",
                result: "Both outcomes checked",
                learning: "Verify each requested outcome before completion",
                tags: ["verification"],
                domain: "work",
                confidence: 0.8,
                importance: 0.7,
                createdAt: 1700000000000,
                updatedAt: 1700000000000,
                accessCount: 1,
              },
            ]
          : [];
        await route.fulfill({ json: { data: records, total: records.length } });
      });
      await openAppPath(page, "/character/experience");
      const root = page.locator(
        '[data-view-lifecycle-slot][data-view-hidden="false"]',
      );
      try {
        await expect(
          root.getByText("Loading experiences…", { exact: true }),
        ).toBeVisible();
        expect(matches(await root.innerText())).toBe(false);
      } finally {
        release();
      }
      await expect(
        root.getByText("I haven’t learned anything yet.", { exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("experience-empty.png"),
        fullPage: true,
      });
      expect(matches(await root.innerText())).toBe(true);
      const navigation = await root.locator("button").allTextContents();
      expect(matches(navigation.join(" "))).toBe(false);
      populated = true;
      await page.reload();
      await expect(root.getByText("Captured", { exact: true })).toBeVisible();
      expect(matches(await root.innerText())).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath("experience-populated.png"),
        fullPage: true,
      });
    });

    test("memory taxonomy preserves labels without forbidden blue", async ({
      page,
    }, testInfo) => {
      const types = ["messages", "memories", "facts", "documents", "other"];
      const memories = types.map((type, i) => ({
        id: `audit-${type}`,
        type,
        text: `A complete ${type} record for visual review.`,
        entityId: null,
        roomId: null,
        agentId: null,
        metadata: null,
        source: null,
        createdAt: 1700000000000 + i,
      }));
      await page.route("**/api/memories/feed?*", (route) =>
        route.fulfill({
          json: { memories, count: memories.length, limit: 50, hasMore: false },
        }),
      );
      await page.route("**/api/memories/stats", (route) =>
        route.fulfill({
          json: {
            total: memories.length,
            byType: Object.fromEntries(types.map((type) => [type, 1])),
          },
        }),
      );
      await page.route("**/api/relationships/people?*", (route) =>
        route.fulfill({
          json: {
            data: [],
            stats: { totalEntities: 0, totalRelationships: 0, totalPeople: 0 },
          },
        }),
      );
      await openAppPath(page, "/apps/memories");
      for (const type of types) {
        const card = page.getByTestId(`memory-card-audit-${type}`);
        await expect(card).toBeVisible();
        await expect(card).toContainText(
          `A complete ${type} record for visual review.`,
        );
      }
      await page.screenshot({
        path: testInfo.outputPath("memory-taxonomy.png"),
        fullPage: true,
      });
      expect(await collectBlueColors(page)).toEqual([]);
      expect(await collectHoverViolations(page)).toEqual({
        violations: [],
        hoverFailures: [],
      });
      await page.getByTestId("memory-card-audit-messages").hover();
      expect(await collectBlueColors(page)).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath("memory-taxonomy-hover.png"),
        fullPage: true,
      });
    });
  });
}

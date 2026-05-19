import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type ViewCase = {
  id: string;
  viewType: "gui" | "tui";
  path: string;
};

type ViewAudit = {
  id: string;
  viewType: "gui" | "tui";
  path: string;
  visibleText: string;
  controls: Array<{
    tag: string;
    role: string | null;
    type: string | null;
    text: string;
    ariaLabel: string | null;
    disabled: boolean;
  }>;
  focusedAfterTabs: string[];
};

const VIEW_CASES: ViewCase[] = [
  ["companion", "gui", "/companion"],
  ["companion", "tui", "/companion/tui"],
  ["contacts", "gui", "/contacts"],
  ["contacts", "tui", "/contacts/tui"],
  ["hyperliquid", "gui", "/hyperliquid"],
  ["hyperliquid", "tui", "/hyperliquid/tui"],
  ["lifeops", "gui", "/lifeops"],
  ["lifeops", "tui", "/lifeops/tui"],
  ["messages", "gui", "/messages"],
  ["messages", "tui", "/messages/tui"],
  ["phone", "gui", "/phone"],
  ["phone", "tui", "/phone/tui"],
  ["polymarket", "gui", "/polymarket"],
  ["polymarket", "tui", "/polymarket/tui"],
  ["shopify", "gui", "/shopify"],
  ["shopify", "tui", "/shopify/tui"],
  ["steward", "gui", "/steward"],
  ["steward", "tui", "/steward/tui"],
  ["vincent", "gui", "/vincent"],
  ["vincent", "tui", "/vincent/tui"],
  ["wallet", "gui", "/wallet"],
  ["wallet", "tui", "/wallet/tui"],
  ["2004scape", "gui", "/2004scape"],
  ["2004scape", "tui", "/2004scape/tui"],
  ["views-manager", "gui", "/views"],
  ["views-manager", "tui", "/views/tui"],
  ["clawville", "gui", "/clawville"],
  ["clawville", "tui", "/clawville/tui"],
  ["defense-of-the-agents", "gui", "/defense-of-the-agents"],
  ["defense-of-the-agents", "tui", "/defense-of-the-agents/tui"],
  ["hyperscape", "gui", "/hyperscape"],
  ["hyperscape", "tui", "/hyperscape/tui"],
  ["scape", "gui", "/scape"],
  ["scape", "tui", "/scape/tui"],
  ["screenshare", "gui", "/screenshare"],
  ["screenshare", "tui", "/screenshare/tui"],
  ["training", "gui", "/training"],
  ["training", "tui", "/training/tui"],
].map(([id, viewType, viewPath]) => ({
  id,
  viewType: viewType as "gui" | "tui",
  path: viewPath,
}));

test.describe("registered plugin views visual coverage", () => {
  for (const view of VIEW_CASES) {
    test(`${view.id} ${view.viewType} renders with page chat`, async ({
      page,
    }) => {
      const screenshotDir =
        process.env.ELIZA_VIEW_SCREENSHOT_DIR ??
        path.join(process.cwd(), "test-results", "plugin-views");
      await mkdir(screenshotDir, { recursive: true });

      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") {
          pageErrors.push(message.text());
        }
      });

      await seedAppStorage(page);
      await installDefaultAppRoutes(page);
      await openAppPath(page, view.path);

      await expect(page.getByText(/Loading view/)).toHaveCount(0, {
        timeout: 30_000,
      });
      await expect(page.getByText("Failed to load view")).toHaveCount(0);
      await expect(
        page.locator('[data-testid="chat-composer-textarea"]').first(),
      ).toBeVisible();
      if (view.viewType === "tui") {
        await expect(page.locator("[data-view-state]").first()).toBeVisible();
        await expect(
          page.locator("main").getByText("elizaos://").first(),
        ).toBeVisible();
      }

      await page.screenshot({
        fullPage: false,
        path: path.join(screenshotDir, `${view.id}-${view.viewType}.png`),
      });

      await page.keyboard.press("/");
      const focusedAfterTabs: string[] = [];
      focusedAfterTabs.push(
        await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element) return "";
          return [
            element.tagName.toLowerCase(),
            element.getAttribute("role") ?? "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("data-testid") ?? "",
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ??
              "",
          ]
            .filter(Boolean)
            .join(":");
        }),
      );
      for (let index = 0; index < 30; index += 1) {
        await page.keyboard.press("Tab");
        focusedAfterTabs.push(
          await page.evaluate(() => {
            const element = document.activeElement as HTMLElement | null;
            if (!element) return "";
            return [
              element.tagName.toLowerCase(),
              element.getAttribute("role") ?? "",
              element.getAttribute("aria-label") ?? "",
              element.getAttribute("data-testid") ?? "",
              element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ??
                "",
            ]
              .filter(Boolean)
              .join(":");
          }),
        );
      }

      const audit = await page.evaluate(
        ({ id, viewType, viewPath, focused }) => {
          const normalize = (value: string | null | undefined) =>
            (value ?? "").trim().replace(/\s+/g, " ");
          const controls = Array.from(
            document.querySelectorAll<HTMLElement>(
              "button, input, textarea, select, [role='button'], [role='menuitem'], [role='tab']",
            ),
          )
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            })
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              type: element.getAttribute("type"),
              text: normalize(element.textContent).slice(0, 120),
              ariaLabel: element.getAttribute("aria-label"),
              disabled:
                element.hasAttribute("disabled") ||
                element.getAttribute("aria-disabled") === "true",
            }));
          return {
            id,
            viewType,
            path: viewPath,
            visibleText: normalize(document.body.innerText).slice(0, 4000),
            controls,
            focusedAfterTabs: focused,
          } satisfies ViewAudit;
        },
        {
          id: view.id,
          viewType: view.viewType,
          viewPath: view.path,
          focused: focusedAfterTabs,
        },
      );

      expect(
        audit.visibleText.length,
        `${view.id} ${view.viewType} should expose readable text`,
      ).toBeGreaterThan(20);
      expect(
        audit.controls.length,
        `${view.id} ${view.viewType} should expose interactive controls`,
      ).toBeGreaterThan(0);
      expect(
        focusedAfterTabs.some((entry) => entry.includes("textarea")),
        `${view.id} ${view.viewType} keyboard tab order should reach chat composer`,
      ).toBe(true);
      if (view.viewType === "tui") {
        expect(
          focusedAfterTabs.some(
            (entry) =>
              entry.includes("button") ||
              entry.includes("input") ||
              entry.includes("textarea"),
          ),
          `${view.id} ${view.viewType} keyboard tab order should reach an actionable control`,
        ).toBe(true);
      }

      await writeFile(
        path.join(screenshotDir, `${view.id}-${view.viewType}.audit.json`),
        `${JSON.stringify(audit, null, 2)}\n`,
      );

      expect(
        pageErrors,
        `${view.id} ${view.viewType} console/page errors`,
      ).toEqual([]);
    });
  }
});

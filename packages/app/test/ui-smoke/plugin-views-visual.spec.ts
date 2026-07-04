/**
 * Playwright UI-smoke spec for the Plugin Views Visual app flow using the real
 * renderer fixture.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";
import { captureScreenshotWithQualityRetry } from "./helpers/screenshot-quality";
import { VIEW_CASES } from "./plugin-view-cases";

const KNOWN_BROKEN = new Set<string>([]);
const MIN_VISIBLE_TEXT_LENGTH_BY_VIEW_ID = new Map<string, number>([
  ["feed", 4],
  ["focus", 4],
  ["social-alpha", 4],
]);
const DEFAULT_MIN_VISIBLE_TEXT_LENGTH = 21;

// Interaction coverage ratchet signals: redundantHeadingParagraphs,
// visualSignals, terminalCommands.
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
    inTuiRoot: boolean;
    terminalCommand: string | null;
  }>;
  focusedAfterTabs: string[];
};

async function expectNoFailedView(
  page: Page,
  pageErrors: string[],
  label: string,
) {
  await expect(
    page.getByText("Failed to load view"),
    `${label} should not render the dynamic view fallback; page errors=${JSON.stringify(
      pageErrors,
      null,
      2,
    )}`,
  ).toHaveCount(0);
}

test.describe("registered plugin views visual coverage", () => {
  for (const view of VIEW_CASES) {
    if (KNOWN_BROKEN.has(view.id)) continue;
    const assistantExpectation =
      view.shellPill === "expected"
        ? "renders with assistant pill"
        : "renders with assistant pill suppressed";
    test(`${view.id} ${view.viewType} ${assistantExpectation}`, async ({
      page,
    }, testInfo) => {
      // The chromium and (opt-in) webkit projects both run this spec; scope
      // artifacts per engine so the WebKit rerun cannot clobber the Chromium
      // screenshots and audit JSON.
      const screenshotDir =
        process.env.ELIZA_VIEW_SCREENSHOT_DIR ??
        path.join(
          process.cwd(),
          "test-results",
          "plugin-views",
          testInfo.project.name,
        );
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
      if (view.id === "social-alpha") {
        await page.route("**/api/social-alpha/leaderboard", async (route) => {
          if (route.request().method() !== "GET") {
            await route.fallback();
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ data: [] }),
          });
        });
      }
      await openAppPath(page, view.path);

      await expectNoFailedView(
        page,
        pageErrors,
        `${view.id} ${view.viewType} initial load`,
      );

      const minVisibleTextLength =
        MIN_VISIBLE_TEXT_LENGTH_BY_VIEW_ID.get(view.id) ??
        DEFAULT_MIN_VISIBLE_TEXT_LENGTH;
      const viewRoot = page.locator("main").first();
      await expect(viewRoot).toBeVisible({ timeout: 60_000 });
      await expect
        .poll(
          async () => {
            const text = await viewRoot.evaluate((root) =>
              (root.textContent ?? "").trim().replace(/\s+/g, " "),
            );
            return (
              text.length >= minVisibleTextLength &&
              !/^Loading view\b/.test(text)
            );
          },
          {
            message: `${view.id} ${view.viewType} should finish dynamic view loading before audit`,
            timeout: 60_000,
          },
        )
        .toBe(true);
      await expect(page.getByText(/Loading view/)).toHaveCount(0);
      await expectNoFailedView(
        page,
        pageErrors,
        `${view.id} ${view.viewType} settled load`,
      );
      const preOverlayAudit = await viewRoot.evaluate(
        (root, { id, viewType, viewPath }) => {
          const normalize = (value: string | null | undefined) =>
            (value ?? "").trim().replace(/\s+/g, " ");
          const controls = Array.from(
            root.querySelectorAll<HTMLElement>(
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
              inTuiRoot: Boolean(element.closest("[data-view-state]")),
              terminalCommand: element.getAttribute("data-terminal-command"),
            }));
          return {
            id,
            viewType,
            path: viewPath,
            visibleText: normalize(root.textContent).slice(0, 4000),
            controls,
            focusedAfterTabs: [],
          } satisfies ViewAudit;
        },
        {
          id: view.id,
          viewType: view.viewType,
          viewPath: view.path,
        },
      );

      expect(
        preOverlayAudit.visibleText.length,
        `${view.id} ${view.viewType} should expose readable view text before opening the assistant overlay`,
      ).toBeGreaterThanOrEqual(minVisibleTextLength);
      if (view.id !== "views-manager") {
        expect(
          preOverlayAudit.visibleText,
          `${view.id} ${view.viewType} should not fall through to the View Manager`,
        ).not.toMatch(/^View Manager \d+ views\b/);
      }
      let hasVisibleLegacyTuiRoot = false;
      if (view.viewType === "tui") {
        const tuiRoot = viewRoot.locator("[data-view-state]").first();
        hasVisibleLegacyTuiRoot = await tuiRoot.isVisible().catch(() => false);
        // Collapsed plugin routes render the shared browser surface; keep the
        // terminal-wrapper contract for legacy `/tui` surfaces when present.
        if (hasVisibleLegacyTuiRoot) {
          await expect(
            tuiRoot,
            `${view.id} ${view.viewType} should render a terminal view root`,
          ).toBeVisible();
          await expect(
            viewRoot.getByText(`elizaos://${view.id} --type=tui`).first(),
            `${view.id} ${view.viewType} should render its own terminal header`,
          ).toBeVisible();
          const terminalCommandCount = await page
            .locator("[data-terminal-command]")
            .count();
          if (terminalCommandCount > 0) {
            for (let index = 0; index < terminalCommandCount; index += 1) {
              await page.locator("[data-terminal-command]").nth(index).click();
            }
            await expect(
              page.locator("[data-terminal-output]"),
              `${view.id} ${view.viewType} should render output for every terminal command`,
            ).toHaveCount(terminalCommandCount);
          }
        }
      }

      await captureScreenshotWithQualityRetry(
        page,
        `${view.id} ${view.viewType}`,
        {
          fullPage: false,
          path: path.join(screenshotDir, `${view.id}-${view.viewType}.png`),
          attempts: 4,
        },
      );

      if (view.shellPill === "expected") {
        const assistantLauncher = page.getByTestId("shell-home-pill").or(
          page.getByRole("button", {
            name: /expand conversation|collapse conversation/i,
          }),
        );
        const assistantComposer = page
          .getByTestId("chat-composer-textarea")
          .or(page.getByLabel("message"))
          .or(page.getByLabel("Message Eliza"))
          .first();
        if ((await assistantLauncher.count()) > 0) {
          await assistantLauncher.first().click();
        }
        await expect(assistantComposer).toBeVisible();
        await assistantComposer.focus();
      } else {
        await expect(
          page.getByTestId("shell-home-pill").or(
            page.getByRole("button", {
              name: /expand conversation|collapse conversation/i,
            }),
          ),
        ).toHaveCount(0);
      }

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
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ?? "",
          ]
            .filter(Boolean)
            .join(":");
        }),
      );
      for (let index = 0; index < 12; index += 1) {
        await page.keyboard.press("Tab");
        const focusedEntry = await page.evaluate(() => {
          const element = document.activeElement as HTMLElement | null;
          if (!element) return "";
          return [
            element.tagName.toLowerCase(),
            element.getAttribute("role") ?? "",
            element.getAttribute("aria-label") ?? "",
            element.getAttribute("data-testid") ?? "",
            element.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ?? "",
          ]
            .filter(Boolean)
            .join(":");
        });
        focusedAfterTabs.push(focusedEntry);
      }

      const audit = await page.evaluate(
        ({ id, viewType, viewPath, focused }) => {
          const root = document.querySelector("main") ?? document.body;
          const normalize = (value: string | null | undefined) =>
            (value ?? "").trim().replace(/\s+/g, " ");
          const controls = Array.from(
            root.querySelectorAll<HTMLElement>(
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
              inTuiRoot: Boolean(element.closest("[data-view-state]")),
              terminalCommand: element.getAttribute("data-terminal-command"),
            }));
          return {
            id,
            viewType,
            path: viewPath,
            visibleText: normalize(root.textContent).slice(0, 4000),
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
      ).toBeGreaterThanOrEqual(minVisibleTextLength);
      if (view.viewType === "tui" && hasVisibleLegacyTuiRoot) {
        expect(
          audit.controls.length,
          `${view.id} ${view.viewType} should expose terminal controls inside the view, not only assistant overlay controls`,
        ).toBeGreaterThan(0);
      }
      if (view.viewType === "tui" && hasVisibleLegacyTuiRoot) {
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

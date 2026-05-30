import { expect, type Page, test } from "@playwright/test";
import {
  installDefaultAppRoutes,
  openAppPath,
  seedAppStorage,
} from "./helpers";

type UiTheme = "light" | "dark";

type Viewport = {
  width: number;
  height: number;
};

type LayoutRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
  borderTopLeftRadius: number;
  borderTopRightRadius: number;
  borderBottomLeftRadius: number;
  borderBottomRightRadius: number;
};

type BackgroundLayoutMetrics = {
  viewport: Viewport;
  documentTheme: string | null;
  appRoot: LayoutRect | null;
  background: LayoutRect | null;
  vrmStage: LayoutRect | null;
  overflow: {
    documentHorizontal: boolean;
    bodyHorizontal: boolean;
    appRootHorizontal: boolean;
  };
};

const THEMES: readonly UiTheme[] = ["light", "dark"];
const VIEWPORT_TOLERANCE_PX = 1;
const RADIUS_TOLERANCE_PX = 0.5;

async function openCompanionApp(page: Page, theme: UiTheme) {
  await seedAppStorage(page, {
    "eliza:ui-theme": theme,
    "elizaos:ui-theme": theme,
  });
  await installDefaultAppRoutes(page);
  await openAppPath(page, "/apps/companion");

  const background = page.getByTestId("companion-background");
  await expect(background).toBeVisible();
  await expect(background).toHaveAttribute("data-theme", theme);
  await expect(page.getByTestId("companion-vrm-stage")).toHaveAttribute(
    "data-theme",
    theme,
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function readBackgroundLayoutMetrics(
  page: Page,
): Promise<BackgroundLayoutMetrics> {
  return page.evaluate(() => {
    const readRect = (element: Element | null): LayoutRect | null => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      const styles = window.getComputedStyle(element);
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        borderTopLeftRadius: Number.parseFloat(styles.borderTopLeftRadius) || 0,
        borderTopRightRadius:
          Number.parseFloat(styles.borderTopRightRadius) || 0,
        borderBottomLeftRadius:
          Number.parseFloat(styles.borderBottomLeftRadius) || 0,
        borderBottomRightRadius:
          Number.parseFloat(styles.borderBottomRightRadius) || 0,
      };
    };

    const appRoot = document.getElementById("root");
    return {
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      documentTheme: document.documentElement.getAttribute("data-theme"),
      appRoot: readRect(appRoot),
      background: readRect(
        document.querySelector('[data-testid="companion-background"]'),
      ),
      vrmStage: readRect(
        document.querySelector('[data-testid="companion-vrm-stage"]'),
      ),
      overflow: {
        documentHorizontal:
          document.documentElement.scrollWidth > window.innerWidth + 1,
        bodyHorizontal: document.body.scrollWidth > window.innerWidth + 1,
        appRootHorizontal:
          appRoot != null && appRoot.scrollWidth > appRoot.clientWidth + 1,
      },
    };
  });
}

function requireRect(rect: LayoutRect | null, label: string): LayoutRect {
  expect(rect, `${label} should exist`).not.toBeNull();
  if (!rect) throw new Error(`${label} should exist`);
  return rect;
}

function expectRectToFillViewport(
  rect: LayoutRect,
  viewport: Viewport,
  label: string,
) {
  expect(Math.abs(rect.left), `${label} left edge`).toBeLessThanOrEqual(
    VIEWPORT_TOLERANCE_PX,
  );
  expect(Math.abs(rect.top), `${label} top edge`).toBeLessThanOrEqual(
    VIEWPORT_TOLERANCE_PX,
  );
  expect(
    Math.abs(rect.right - viewport.width),
    `${label} right edge`,
  ).toBeLessThanOrEqual(VIEWPORT_TOLERANCE_PX);
  expect(
    Math.abs(rect.bottom - viewport.height),
    `${label} bottom edge`,
  ).toBeLessThanOrEqual(VIEWPORT_TOLERANCE_PX);
  expect(
    Math.abs(rect.width - viewport.width),
    `${label} width`,
  ).toBeLessThanOrEqual(VIEWPORT_TOLERANCE_PX);
  expect(
    Math.abs(rect.height - viewport.height),
    `${label} height`,
  ).toBeLessThanOrEqual(VIEWPORT_TOLERANCE_PX);
}

function expectNoBackgroundCornerClipping(rect: LayoutRect) {
  expect(rect.borderTopLeftRadius).toBeLessThanOrEqual(RADIUS_TOLERANCE_PX);
  expect(rect.borderTopRightRadius).toBeLessThanOrEqual(RADIUS_TOLERANCE_PX);
  expect(rect.borderBottomLeftRadius).toBeLessThanOrEqual(RADIUS_TOLERANCE_PX);
  expect(rect.borderBottomRightRadius).toBeLessThanOrEqual(RADIUS_TOLERANCE_PX);
}

for (const theme of THEMES) {
  test(`companion background fills the viewport in ${theme} mode`, async ({
    page,
  }) => {
    await openCompanionApp(page, theme);

    const metrics = await readBackgroundLayoutMetrics(page);
    expect(metrics.documentTheme).toBe(theme);
    expect(metrics.overflow).toEqual({
      documentHorizontal: false,
      bodyHorizontal: false,
      appRootHorizontal: false,
    });

    expectRectToFillViewport(
      requireRect(metrics.appRoot, "app root"),
      metrics.viewport,
      "app root",
    );
    const background = requireRect(metrics.background, "companion background");
    expectRectToFillViewport(
      background,
      metrics.viewport,
      "companion background",
    );
    expectNoBackgroundCornerClipping(background);
    expectRectToFillViewport(
      requireRect(metrics.vrmStage, "companion VRM stage"),
      metrics.viewport,
      "companion VRM stage",
    );
  });
}

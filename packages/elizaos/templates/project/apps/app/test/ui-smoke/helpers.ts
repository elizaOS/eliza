import { expect, type Locator, type Page } from "@playwright/test";

export const ROOT_TIMEOUT_MS = 20_000;
export const NAV_TIMEOUT_MS = 12_000;

type ReadyCheck =
  | { selector: string; text?: never }
  | { selector?: never; text: string };

type EvaluatedReadyCheck = {
  check: ReadyCheck;
  passed: boolean;
};

export const DEFAULT_APP_STORAGE: Record<string, string> = {
  "eliza:onboarding-complete": "1",
  "eliza:onboarding:step": "activate",
  "eliza:ui-shell-mode": "native",
  "elizaos:active-server": JSON.stringify({
    id: "local:embedded",
    kind: "local",
    label: "This device",
  }),
};

export async function seedAppStorage(
  page: Page,
  overrides: Record<string, string> = {},
): Promise<void> {
  const storage = { ...DEFAULT_APP_STORAGE, ...overrides };
  await page.addInitScript((entries: Record<string, string>) => {
    for (const [key, value] of Object.entries(entries)) {
      localStorage.setItem(key, value);
    }
  }, storage);
}

export async function expectRootReady(page: Page): Promise<void> {
  await expect(page.locator("#root")).toBeVisible({ timeout: ROOT_TIMEOUT_MS });
}

export async function expectNoOnboardingRedirect(page: Page): Promise<void> {
  await expect(page).not.toHaveURL(/onboarding/, { timeout: NAV_TIMEOUT_MS });
}

export async function openAppPath(
  page: Page,
  targetPath: string,
): Promise<void> {
  await page.goto(targetPath, { waitUntil: "domcontentloaded" });
  await expectRootReady(page);
  await expectNoOnboardingRedirect(page);
}

export async function readLocalStorage(
  page: Page,
  key: string,
): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

async function locatorVisible(locator: Locator): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

function formatReadyCheck(check: ReadyCheck): string {
  if ("selector" in check) {
    return `selector=${check.selector}`;
  }
  return `text=${JSON.stringify(check.text)}`;
}

function readyChecksPassed(
  results: EvaluatedReadyCheck[],
  mode: "any" | "all",
): boolean {
  if (mode === "all") {
    return results.every((result) => result.passed);
  }
  return results.some((result) => result.passed);
}

async function evaluateReadyChecks(
  page: Page,
  checks: ReadyCheck[],
  mode: "any" | "all" = "any",
): Promise<{
  passed: boolean;
  results: EvaluatedReadyCheck[];
}> {
  const results: EvaluatedReadyCheck[] = [];

  for (const check of checks) {
    if ("selector" in check) {
      results.push({
        check,
        passed: await locatorVisible(page.locator(check.selector)),
      });
      continue;
    }
    results.push({
      check,
      passed: await locatorVisible(page.getByText(check.text)),
    });
  }

  return {
    passed: readyChecksPassed(results, mode),
    results,
  };
}

export async function assertReadyChecks(
  page: Page,
  label: string,
  checks: ReadyCheck[],
  mode: "any" | "all" = "any",
): Promise<void> {
  const evaluation = await evaluateReadyChecks(page, checks, mode);
  const summary = evaluation.results
    .map(
      (result) =>
        `${result.passed ? "pass" : "fail"}:${formatReadyCheck(result.check)}`,
    )
    .join(", ");

  expect(
    evaluation.passed,
    `[playwright-ui-smoke] ${label}: ready checks failed (${summary})`,
  ).toBe(true);
}

export async function runSoftReadyChecks(
  page: Page,
  label: string,
  checks: ReadyCheck[],
  mode: "any" | "all" = "any",
): Promise<void> {
  const evaluation = await evaluateReadyChecks(page, checks, mode);
  if (evaluation.passed) {
    return;
  }

  const summary = evaluation.results
    .map(
      (result) =>
        `${result.passed ? "pass" : "fail"}:${formatReadyCheck(result.check)}`,
    )
    .join(", ");
  console.warn(
    `[playwright-ui-smoke] ${label}: ready checks failed (${summary}).`,
  );
}

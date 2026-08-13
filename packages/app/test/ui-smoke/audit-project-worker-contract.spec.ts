/**
 * Verifies that each opt-in aesthetic-audit project remains identifiable in a
 * real Playwright worker after the launcher process has loaded configuration.
 */

import { expect, test } from "@playwright/test";
import { UI_SMOKE_AUDIT_PROJECTS } from "../../scripts/lib/playwright-audit-projects.mjs";

test("worker retains the explicitly requested audit project", ({
  browserName,
  serviceWorkers,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  expect(UI_SMOKE_AUDIT_PROJECTS).toContain(testInfo.project.name);
  expect(serviceWorkers).toBe(
    testInfo.project.name === "audit-app" ? "block" : "allow",
  );
});
